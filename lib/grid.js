/**
 * stage1：候选枚举。纯函数，零模型调用。
 *
 * 两段式设计：
 *   第二节 候选单位是一对「读格 R × 动作格 A」，R 在前
 *   第三节 对象1 与对象2 的亲和度（只进排序，不进合法性）
 *   第五节 两段枚举（R 排序取 N_R → 每个 R 配 M_A 个 A → 合并排序编号）
 *   第六节 排序分与破同分六步
 *   第七节 记账：recentCombos 记「对」，lastActionCells 记动作格
 *
 * 这一层只算不用：谁调用、怎么拼进 stage2 提示词是接线那一批的事。这里不读配置、
 * 不读 state、不写日志，屏幕外的输入全从参数进来，同样的输入必然得到同样的输出。
 *
 * 与规则第五节的偏差（只此一处，报告里写明了）：伪代码里亲和度是软门
 * （「affinity == 0 且存在亲和对」才剔），但第五节实算、第十一节逐条、第十三节的
 * 13/16 对都是按硬门算出来的；软门会让单段只读永远触发不了（每个 R 都补得上零亲和 A）。
 * 这里按硬门实现：亲和度 0 的动作格不进这一对的候选。
 */
import { isSelfReferential } from './gate.js';
import { SELF_OPTIMIZE_COOLDOWN_MS, normalizeMaterials } from './proposer.js';

/** 候选上限的兜底（规则 6.1 `proposer.maxCandidates`，默认 24）。 */
export const DEFAULT_MAX_CANDIDATES = 24;

/**
 * 八条原语，顺序即规则第三节的表序（也是排序的最后一道 tie-break）。
 * `id` 是规则里的叫法（`edit-file`），`key` 是 yaml 配置里的驼峰写法（`editFile`）。
 * `impact` 按「手伸到哪」归档，是 5.1 输出里给 stage2/GA6 用的默认档；
 * `reversibility` 抄第三节「默认撤回」列（P2 未跟踪文件升 manual、P4 stop 降 none
 * 这类实例级判断发生在 stage2/gate，不在这里猜）。
 */
export const PRIMITIVES = [
  { id: 'inspect', key: 'inspect', label: '读', readonly: true, impact: 'read', reversibility: 'auto', entry: 'glob/grep/read' },
  { id: 'edit-file', key: 'editFile', label: '改文件', readonly: false, impact: 'local-write', reversibility: 'auto', entry: 'read+grep 定位' },
  { id: 'edit-config', key: 'editConfig', label: '改配置', readonly: false, impact: 'local-write', reversibility: 'manual', entry: 'read → grep 键路径' },
  { id: 'service', key: 'service', label: '动服务', readonly: false, impact: 'process', reversibility: 'manual', entry: 'host_status' },
  { id: 'memory-write', key: 'memoryWrite', label: '写记忆', readonly: false, impact: 'memory', reversibility: 'manual', entry: 'memory_recall → memory_entity' },
  { id: 'delete', key: 'delete', label: '删除', readonly: false, impact: 'irreversible', reversibility: 'none', entry: 'glob 拿数量+路径' },
  { id: 'outbound', key: 'outbound', label: '外部通信', readonly: false, impact: 'outbound', reversibility: 'none', entry: 'chat 发送' },
  { id: 'external-research', key: 'externalResearch', label: '外部检索', readonly: true, impact: 'read-remote', reversibility: 'auto', entry: 'web_search/web_fetch' },
];

/** 八类对象，顺序即规则第四节的列序。`key` 是 yaml 配置里的写法。 */
export const OBJECT_KINDS = [
  { id: 'files', key: 'files', label: '文件' },
  { id: 'config', key: 'config', label: '配置' },
  { id: 'service', key: 'service', label: '服务' },
  { id: 'memory', key: 'memory', label: '记忆' },
  { id: 'ticket', key: 'ticket', label: '票' },
  { id: 'session', key: 'session', label: '会话' },
  { id: 'external-doc', key: 'externalDoc', label: '外部资料' },
  { id: 'external-repo', key: 'externalRepo', label: '外部仓库' },
];

/**
 * 配对矩阵（规则第四节整张表，`—` 的格不写）。
 * 八行加起来 8 + 1 + 1 + 1 + 1 + 2 + 1 + 2 = 17 个基础格。
 * 两段式不让它决定 R×A 能不能搭——每个格各自过这张表，亲和度另算。
 */
export const PAIRING_MATRIX = {
  inspect: ['files', 'config', 'service', 'memory', 'ticket', 'session', 'external-doc', 'external-repo'],
  'edit-file': ['files'],
  'edit-config': ['config'],
  service: ['service'],
  'memory-write': ['memory'],
  delete: ['files', 'external-repo'],
  outbound: ['session'],
  'external-research': ['external-doc', 'external-repo'],
};

/** 矩阵摊平成 `primitive|objectKind` 集合，查一格合不合法就一次 has。 */
export const PAIR_SET = new Set(
  Object.entries(PAIRING_MATRIX).flatMap(([primitive, objects]) => objects.map((objectKind) => `${primitive}|${objectKind}`)),
);

/**
 * 读格（R）允许的原语：规则第二节 P1 / P8（`readonly: true` 那两条）。
 * 动作格（A）是其余六条。两份集合与 gate 的 GA16 口径一致，由单测钉住。
 */
export const ROLE_READ = ['inspect', 'external-research'];
export const ROLE_ACTION = ['edit-file', 'edit-config', 'service', 'memory-write', 'delete', 'outbound'];
const ROLE_READ_SET = new Set(ROLE_READ);
const ROLE_ACTION_SET = new Set(ROLE_ACTION);

/** 每拍最多取几个读格 R（规则第五节 N_R = 12；现在 R 一共 10 格，这一条剪不到东西）。 */
export const DEFAULT_MAX_READS = 12;

/** 每个读格最多配几个动作格 A（规则第五节 M_A = 2）。 */
export const MAX_ACTIONS_PER_READ = 2;

/** 允许出「单段只读」的动机（规则第四节第 1 条，其余五档不许单段）。 */
export const SINGLE_READ_MOTIVATIONS = ['hygiene', 'status'];

/**
 * 动机权重（规则 5.1 第 4 条：backlog/status 高，hygiene 低）。
 * 只影响排序，不决定格子合不合法。
 */
export const MOTIVATION_WEIGHTS = {
  backlog: 3,
  status: 3,
  sync: 2,
  memory: 2,
  social: 2,
  hygiene: 1,
  self: 1,
};

/**
 * 动机天然指向哪几条原语（规则 5.1 第 2 条那张表的老内容）。
 *
 * 两段式起**不再当合法性用**（票面与规则第四节冲突 2）：hygiene 素材读到 files
 * 发现其实是配置问题，A 要能落 edit-config，不能被「hygiene 只许 inspect / edit-file」
 * 剪掉。现在这一栏只剩一个用途：R 排序时看「这条动机本来是不是就想读这条原语」，
 * 同分时契合的排前面（buildGrid 的 `fits`）。A 侧完全不看它。
 */
export const MOTIVATION_PRIMITIVES = {
  backlog: ['inspect', 'edit-file', 'edit-config', 'service', 'memory-write', 'delete', 'external-research'],
  hygiene: ['inspect', 'edit-file', 'edit-config', 'delete'],
  sync: ['inspect', 'external-research'],
  social: ['inspect', 'outbound'],
  memory: ['inspect', 'memory-write'],
  status: ['inspect', 'service'],
  self: ['inspect', 'edit-file', 'edit-config'],
};

/**
 * 同一条素材最多挂到几个读格 R 上（规则第五节「素材新鲜度」）。
 * 素材池是「方向」不是「实例」，一条方向铺满所有 R 会把候选表变成同一句话刷屏；
 * 限 2 次，9 条素材的默认池正好够 10 个 R 铺满（10 ≤ 9×2）。
 * 注意计的是 R 不是对：一个 R 配两个 A 时，那两对共用同一句种子。
 */
export const MAX_SLOTS_PER_MATERIAL = 2;

/** 对象新鲜度的满分；被 recentCombos 提过的 R 对象类每次扣 1，扣到 0 为止。 */
export const FRESHNESS_MAX = 3;

/**
 * 亲和度表（规则第三节，只进排序）。键是 `读对象|动对象`，值是 1（有亲和）或 2（同对象）。
 * 没写的组合一律 0：允许成对那一条在第五节实算里被剪掉了，见文件头。
 */
export const PAIR_AFFINITY = {
  'files|config': 1,
  'config|files': 1,
  'config|service': 1,
  'service|config': 1,
  'external-doc|files': 1,
  'external-doc|memory': 1,
  'external-repo|files': 1,
  'external-repo|memory': 1,
};

/**
 * 一对的亲和度：同对象 2（第三节「同对象 +3」那一档），表里写的跨域 1，其余 0。
 * @param {string} readObjectKind 读格的对象类
 * @param {string} actionObjectKind 动作格的对象类
 * @returns {0|1|2}
 */
export function affinityOf(readObjectKind, actionObjectKind) {
  const read = String(readObjectKind ?? '').trim();
  const action = String(actionObjectKind ?? '').trim();
  if (!read || !action) return 0;
  if (read === action) return 2;
  return Number(PAIR_AFFINITY[`${read}|${action}`]) || 0;
}

/** 原语别名 → 规则 id（recentCombos 里可能存 `P6` / `delete` / 配置键 `editFile`）。 */
const PRIMITIVE_ALIASES = new Map();
for (let i = 0; i < PRIMITIVES.length; i += 1) {
  const p = PRIMITIVES[i];
  PRIMITIVE_ALIASES.set(p.id, p.id);
  PRIMITIVE_ALIASES.set(p.key.toLowerCase(), p.id);
  PRIMITIVE_ALIASES.set(`p${i + 1}`, p.id);
}

/** 对象类别别名 → 规则 id（`ext-doc`、`externalDoc` 都认）。 */
const OBJECT_ALIASES = new Map();
for (const o of OBJECT_KINDS) {
  OBJECT_ALIASES.set(o.id, o.id);
  OBJECT_ALIASES.set(o.key.toLowerCase(), o.id);
}
OBJECT_ALIASES.set('ext-doc', 'external-doc');
OBJECT_ALIASES.set('ext-repo', 'external-repo');

/** 一格的键分隔符：`inspect:files`、`inspect×files`、`inspect|files` 都认。 */
const CELL_SEPARATOR = /[:×|]/;

/** 一对的键分隔符：`inspect|files→edit-file|files`。 */
export const COMBO_ARROW = '→';
const ARROW_SPLIT = new RegExp(COMBO_ARROW);

/** `primitive|objectKind`：一格的规范键，认不出返回空串。 */
function cellKey(cell) {
  return `${cell.primitive.id}|${cell.objectKind.id}`;
}

/**
 * 把一条「一格」的写法（`P6×files` / `delete:files` / `{primitive, objectKind}`）归一。
 * @param {unknown} item
 * @returns {string} `primitive|objectKind`，或空串
 */
export function normalizeCellKey(item) {
  if (item && typeof item === 'object') {
    const primitive = PRIMITIVE_ALIASES.get(String(item.primitive ?? '').trim().toLowerCase());
    const objectKind = OBJECT_ALIASES.get(String(item.objectKind ?? item.object ?? '').trim().toLowerCase());
    return primitive && objectKind ? `${primitive}|${objectKind}` : '';
  }
  const parts = String(item ?? '').trim().toLowerCase().split(CELL_SEPARATOR);
  if (parts.length !== 2) return '';
  const primitive = PRIMITIVE_ALIASES.get(parts[0].trim());
  const objectKind = OBJECT_ALIASES.get(parts[1].trim());
  return primitive && objectKind ? `${primitive}|${objectKind}` : '';
}

/**
 * 把一条 recentCombos 记录归一成「对」的键：
 *   `inspect|files→edit-file|files`（两段）
 *   `inspect|files→`（单段只读：箭尾留空。统一写法——不带箭头的
 *   `inspect|files` 是上一版的单格记账口径，两者必须能分开，否则单段那一格
 *   读回 state 时会被当老键丢掉，永远不轮换）
 * 认不出的、以及老的一格格式（`inspect|files` / `{primitive, objectKind}`，
 * 那是上一版的记账口径）一律返回空串——规则第七节：旧记录丢弃重来。
 *
 * @param {unknown} item
 * @returns {string} 对的键（单段是箭尾留空的两段写法），或空串
 */
export function normalizeComboKey(item) {
  if (item && typeof item === 'object') {
    // 新的对形态：{read, action}（action 为 null 就是单段读）
    if ('read' in item || 'action' in item) {
      const read = normalizeCellKey(item.read);
      const action = item.action ? normalizeCellKey(item.action) : '';
      if (!read) return '';
      if (!action) return cellKeyIsRead(read) ? `${read}${COMBO_ARROW}` : '';
      return cellKeyIsRead(read) && cellKeyIsAction(action) ? `${read}${COMBO_ARROW}${action}` : '';
    }
    return '';
  }
  const raw = String(item ?? '').trim();
  if (!raw) return '';
  const parts = raw.split(ARROW_SPLIT);
  // 不带箭头 = 上一版的单格记账（含动作格那一格），一律丢弃；新的单段一定带箭尾
  if (parts.length === 1) return '';
  if (parts.length !== 2) return '';
  const read = normalizeCellKey(parts[0]);
  if (!read || !cellKeyIsRead(read)) return '';
  if (!String(parts[1] ?? '').trim()) return `${read}${COMBO_ARROW}`;
  const action = normalizeCellKey(parts[1]);
  if (!action) return '';
  return cellKeyIsAction(action) ? `${read}${COMBO_ARROW}${action}` : '';
}

/** `primitive|objectKind` 的原语是不是读侧。 */
function cellKeyIsRead(key) {
  return ROLE_READ_SET.has(key.slice(0, key.indexOf('|')));
}

/** `primitive|objectKind` 的原语是不是动作侧。 */
function cellKeyIsAction(key) {
  return ROLE_ACTION_SET.has(key.slice(0, key.indexOf('|')));
}

/** 冷却期起点：`lastSelfIdeaAt` 是毫秒数或 ISO 串都认，认不出当没有。 */
function toTimestamp(value) {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const asDate = Date.parse(String(value ?? ''));
  return Number.isFinite(asDate) ? asDate : 0;
}

/** 候选上限的归一：缺省/非数字/小于 1 都回默认 24，小数向下取整。 */
function toMaxCandidates(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_CANDIDATES;
}

/** 上限类参数的归一：非数字 / 小于 1 都回默认。 */
function toLimit(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * 读建议：按对象类取那一类，收成干净的字符串数组。
 * 表是 `lib/read-hints.js` 枚举好的，这里只做取用——grid 保持纯函数，不碰 fs、不碰配置。
 */
function hintsOf(table, objectKindId) {
  const list = table && typeof table === 'object' ? table[objectKindId] : null;
  return Array.isArray(list) ? list.map((one) => String(one ?? '').trim()).filter(Boolean) : [];
}

/** 一格在候选行里的写法：读 `读 × 对象`、动作 `动 × 对象`。 */
function noteOf(row) {
  const tail = `｜种子：${row.material.text}`;
  const read = `读 ${row.read.primitive.label} × ${row.read.objectKind.label}`;
  if (!row.action) {
    return `${read}｜只读 ${row.read.primitive.reversibility}｜单段读（这一拍配不出动作格）｜入口 ${row.read.primitive.entry}${tail}`;
  }
  const action = `动 ${row.action.primitive.label} × ${row.action.objectKind.label}`;
  return `${read} → ${action}｜有副作用 ${row.action.primitive.reversibility}｜入口 ${row.action.primitive.entry}${tail}`;
}

/**
 * 枚举一拍的全部候选对。
 *
 * @param {object} input
 * @param {Array<{text: string, motivation: string}>} [input.materials] 素材池（配置项 `proposer.materials`，
 *   口径同 proposer.js `normalizeMaterials`：空 text 与未知 motivation 会被剔）
 * @param {Record<string, boolean>} [input.primitives] 原语开关，**显式 true 才开**（配的是白名单）
 * @param {Record<string, boolean>} [input.objects] 对象开关，**显式 true 才开**
 * @param {number} [input.maxCandidates] 候选上限，默认 24
 * @param {number|string} [input.lastSelfIdeaAt] 上次自指点子的时间（毫秒或 ISO 串）
 * @param {Array<unknown>} [input.recentCombos] 最近几拍提过的「对」，命中的对整对剔掉
 * @param {Array<unknown>} [input.lastActionCells] 上一拍用掉的动作格，命中的 A 这一拍不进候选
 * @param {number|Date} [input.now] 判冷却用的当前时间
 * @param {number} [input.materialSlots] 一条素材最多挂几个读格，默认 2
 * @param {string} [input.lastMaterial] 上一拍用掉的素材文本；命中的对整组排到队尾（不剔除）
 * @param {number} [input.maxReads] 每拍最多取几个读格 R，默认 12
 * @param {number} [input.maxActionsPerRead] 每个读格最多配几个动作格 A，默认 2
 * @param {Record<string, string[]>} [input.readHints] 读建议表：key 是读格的对象类，value 是
 *   运行时枚举出来的真实路径（`lib/read-hints.js` 算好传进来；grid 自己不读盘、不读配置）
 * @returns {Array<{id: string, read: {primitive: string, primitiveKey: string, objectKind: string, objectKey: string},
 *   action: {primitive: string, primitiveKey: string, objectKind: string, objectKey: string}|null,
 *   material: string, motivation: string, note: string, score: number, readHints: string[],
 *   defaults: {impact: string, reversibility: string}}>} 按排序截断后、id 从 C01 顺序编号的候选对
 */
export function buildGrid({
  materials = [],
  primitives = {},
  objects = {},
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  lastSelfIdeaAt = 0,
  recentCombos = [],
  lastActionCells = [],
  now = Date.now(),
  materialSlots = MAX_SLOTS_PER_MATERIAL,
  lastMaterial = '',
  maxReads = DEFAULT_MAX_READS,
  maxActionsPerRead = MAX_ACTIONS_PER_READ,
  readHints = {},
} = {}) {
  const limit = toMaxCandidates(maxCandidates);
  const slotLimit = toLimit(materialSlots, MAX_SLOTS_PER_MATERIAL);
  const readLimit = toLimit(maxReads, DEFAULT_MAX_READS);
  const actionLimit = toLimit(maxActionsPerRead, MAX_ACTIONS_PER_READ);
  const nowMs = now instanceof Date ? now.getTime() : toTimestamp(now);

  // 素材池：沿用线上同一套剔条口径（空 text、不在档位里的 motivation）。
  const { materials: pool } = normalizeMaterials(materials);
  if (pool.length === 0) return [];

  // 自指冷却（规则 5.1 第 3 条 + proposer.js filterMaterialsByCooldown 的冷却口径）：
  // 冷却期内，motivation=self 的素材、以及文本命中 isSelfReferential 的素材都不进池。
  const lastSelf = toTimestamp(lastSelfIdeaAt);
  const cooling = lastSelf > 0 && nowMs - lastSelf < SELF_OPTIMIZE_COOLDOWN_MS;
  const live = pool
    .filter((item) => !(cooling && (item.motivation === 'self' || isSelfReferential(item.text))))
    .map((item, index) => ({
      text: item.text,
      motivation: item.motivation,
      index,
      weight: MOTIVATION_WEIGHTS[item.motivation] ?? 0,
      used: 0,
    }));
  if (live.length === 0) return [];

  /*
   * recentCombos 只认「对」。老的一格格式（上一版的记账口径）在 normalizeComboKey
   * 里就返回空串，这里自然丢掉——规则第七节：旧记录直接重来，别当成对补一个动作。
   * 对象新鲜度按 R 的对象算（第六节），所以两个用途读同一份记录。
   */
  const recentPairs = new Set();
  const objectSeen = new Map();
  for (const item of Array.isArray(recentCombos) ? recentCombos : []) {
    const key = normalizeComboKey(item);
    if (!key) continue;
    recentPairs.add(key);
    const readPart = key.split(ARROW_SPLIT)[0];
    const readObject = readPart.slice(readPart.indexOf('|') + 1);
    objectSeen.set(readObject, (objectSeen.get(readObject) ?? 0) + 1);
  }
  const cooledActions = new Set(
    (Array.isArray(lastActionCells) ? lastActionCells : []).map(normalizeCellKey).filter(Boolean),
  );

  /*
   * 两个格池：R（只读原语）与 A（有副作用原语），各自过配对矩阵与开关。
   * 开关按白名单判（显式 true 才开）：漏传一个键宁可少一格，也不许把 outbound /
   * memory-write 这类默认关着的原语放出来。
   */
  const readCells = [];
  const actionCells = [];
  for (const primitive of PRIMITIVES) {
    const isRead = ROLE_READ_SET.has(primitive.id);
    const isAction = ROLE_ACTION_SET.has(primitive.id);
    if (!isRead && !isAction) continue;
    if (primitives?.[primitive.key] !== true) continue;
    for (const objectKind of OBJECT_KINDS) {
      if (objects?.[objectKind.key] !== true) continue;
      if (!PAIR_SET.has(`${primitive.id}|${objectKind.id}`)) continue;
      if (isRead) readCells.push({ primitive, objectKind, seq: readCells.length });
      else actionCells.push({ primitive, objectKind, seq: actionCells.length });
    }
  }
  if (readCells.length === 0) return [];

  /*
   * 挂素材：一个读格一条种子（一对共用这一条，A 侧不再单独挂）。
   * 顺序按格池生成序，格内挑法：用得最少的优先，其次动机权重高的，其次素材在池里靠前的。
   * 全部确定，同样的输入必得同样的分配。
   */
  const keptReads = [];
  for (const cell of readCells) {
    const usable = live
      .filter((material) => material.used < slotLimit)
      .sort((a, b) => a.used - b.used || b.weight - a.weight || a.index - b.index);
    const material = usable[0];
    if (!material) continue; // 素材额度全用满了：这一格这一拍没有种子
    material.used += 1;
    keptReads.push({ cell, material });
  }
  if (keptReads.length === 0) return [];

  /*
   * R 排序与截断（规则第五节）：动机权重 → R 对象新鲜度 → 素材新鲜度 →
   * 动机与原语的契合（MOTIVATION_PRIMITIVES 现在只在这里起作用）→ 格池序。
   */
  const readRank = keptReads.map(({ cell, material }) => {
    const seen = objectSeen.get(cell.objectKind.id) ?? 0;
    return {
      cell,
      material,
      freshness: FRESHNESS_MAX - Math.min(seen, FRESHNESS_MAX),
      materialFresh: FRESHNESS_MAX - Math.min(material.used, FRESHNESS_MAX),
      fits: (MOTIVATION_PRIMITIVES[material.motivation] ?? []).includes(cell.primitive.id) ? 1 : 0,
    };
  });
  readRank.sort(
    (a, b) =>
      b.material.weight - a.material.weight ||
      b.freshness - a.freshness ||
      b.materialFresh - a.materialFresh ||
      b.fits - a.fits ||
      a.cell.seq - b.cell.seq,
  );
  const readsTaken = readRank.slice(0, readLimit);

  /*
   * 每个 R 配 A：先剔「对级冷却」（这一对提过）和「动作格连续两拍冷却」，再按亲和度
   * 与动作原语序排；亲和度 0 的不成对（见文件头），所以配不出 A 的 R 才轮到单段读。
   */
  const rows = [];
  let single = null;
  for (const { cell: readCell, material, freshness } of readsTaken) {
    const usable = [];
    for (const actionCell of actionCells) {
      const pairKey = `${cellKey(readCell)}${COMBO_ARROW}${cellKey(actionCell)}`;
      if (recentPairs.has(pairKey)) continue;
      if (cooledActions.has(cellKey(actionCell))) continue;
      const affinity = affinityOf(readCell.objectKind.id, actionCell.objectKind.id);
      if (affinity < 1) continue;
      usable.push({ actionCell, affinity });
    }
    usable.sort((a, b) => b.affinity - a.affinity || a.actionCell.seq - b.actionCell.seq);
    const selected = usable.slice(0, actionLimit);
    if (selected.length === 0) {
      /*
       * 单段只读：只在 hygiene / status 下开口，全拍最多一格（规则第四节第 1、2、5 条）。
       * 它同样进 recentCombos，键是箭尾留空的 `inspect|session→`；记过就这一拍不再补，
       * 否则同一格会连着反复被选中、反复读。
       */
      const singleKey = `${cellKey(readCell)}${COMBO_ARROW}`;
      if (!single && !recentPairs.has(singleKey) && SINGLE_READ_MOTIVATIONS.includes(material.motivation)) {
        single = {
          read: readCell,
          action: null,
          material,
          freshness,
          affinity: 0,
          score: material.weight * 10 + freshness,
        };
      }
      continue;
    }
    for (const { actionCell, affinity } of selected) {
      const sameObject = readCell.objectKind.id === actionCell.objectKind.id;
      rows.push({
        read: readCell,
        action: actionCell,
        material,
        affinity,
        /*
         * 排序分（第六节）：动机权重×10 + 对象新鲜度 + 同对象 3 + 有产出原语 2 + 亲和对 1。
         * 同对象同时拿到 3 和 1（亲和度 2 ≥ 1），别实现成二选一。
         */
        score: material.weight * 10 + freshness + (sameObject ? 3 : 0) + 2 + 1,
      });
    }
  }
  if (single) rows.push(single);
  if (rows.length === 0) return [];

  /*
   * 破同分六步（第六节）：score 降序 → A 原语表序 → R 原语表序 → R 对象表序 →
   * 素材池序号 → 对的键字典序。单段没有 A，A 序按「排在所有动作原语之后」算。
   */
  const primitiveSeq = new Map(PRIMITIVES.map((p, i) => [p.id, i]));
  const objectSeq = new Map(OBJECT_KINDS.map((o, i) => [o.id, i]));
  const actionOrder = (row) => (row.action ? primitiveSeq.get(row.action.primitive.id) : PRIMITIVES.length);
  const pairKeyOf = (row) => (row.action
    ? `${cellKey(row.read)}${COMBO_ARROW}${cellKey(row.action)}`
    : `${cellKey(row.read)}${COMBO_ARROW}`);
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      actionOrder(a) - actionOrder(b) ||
      primitiveSeq.get(a.read.primitive.id) - primitiveSeq.get(b.read.primitive.id) ||
      objectSeq.get(a.read.objectKind.id) - objectSeq.get(b.read.objectKind.id) ||
      a.material.index - b.material.index ||
      pairKeyOf(a).localeCompare(pairKeyOf(b)),
  );

  /*
   * 上一拍用过的素材整组排到队尾。
   * 为什么要这一段：pick 只取第一对，同一素材连着两拍当 C01 会被 gate 的 GA13
   * 判「同一素材连续两拍」把 do 降级成 ask，用户那边每分钟被问一次。
   * 只排后不剔除：素材池窄的时候（只有一两条）候选数量一对不少。
   * 两段各自保持上一段排好的顺序，所以仍是稳定、确定的。
   */
  const lastText = String(lastMaterial ?? '').trim();
  const ordered = lastText
    ? [
        ...rows.filter((one) => one.material.text !== lastText),
        ...rows.filter((one) => one.material.text === lastText),
      ]
    : rows;

  // 截断后编号：stage2 的 pick 只认表内 id，所以截断在前、编号在后。
  return ordered.slice(0, limit).map((row, i) => {
    const read = {
      primitive: row.read.primitive.id,
      primitiveKey: row.read.primitive.key,
      objectKind: row.read.objectKind.id,
      objectKey: row.read.objectKind.key,
    };
    const action = row.action
      ? {
          primitive: row.action.primitive.id,
          primitiveKey: row.action.primitive.key,
          objectKind: row.action.objectKind.id,
          objectKey: row.action.objectKind.key,
        }
      : null;
    return {
      id: `C${String(i + 1).padStart(2, '0')}`,
      read,
      action,
      material: row.material.text,
      motivation: row.material.motivation,
      note: noteOf(row),
      score: row.score,
      /*
       * 读建议：按读格的对象类取那一类（读 inspect×config 就取 config 那一栏）。
       * 空表 / 这一格没配就给空数组（渲染层会写一句兜底，不让这一栏凭空消失）。
       */
      readHints: hintsOf(readHints, row.read.objectKind.id),
      // 默认档取 A（探索票按最坏情形记账，规则第十节）；单段读取 R 的那一档
      defaults: action
        ? { impact: row.action.primitive.impact, reversibility: row.action.primitive.reversibility }
        : { impact: row.read.primitive.impact, reversibility: row.read.primitive.reversibility },
    };
  });
}
