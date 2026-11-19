/**
 * stage1：候选枚举。纯函数，零模型调用。
 *
 * 两段式设计：
 *   第二节 候选单位是一对「读格 R × 动作格 A」，R 在前
 *   第三节 对象1 与对象2 的亲和度（只进排序，不进合法性）
 *   第四节 合法组合：约束表 `PAIR_CONSTRAINTS`（操作 → 允许的对象类），不再手写稀疏矩阵
 *   第五节 两段枚举（运行时枚举 + 稳定格号 → R 排序取 N_R → 每个 R 配 A → 按权重抽取）
 *   第六节 确定性排序分与破同分六步（只给单测/回放；线上走加权随机）
 *   第七节 记账：recentCombos 记「对」，lastActionCells 记动作格，lastGridSeed 记抽取 seed
 *
 * 这一层只算不用：谁调用、怎么拼进 stage2 提示词是接线那一批的事。这里不读配置、
 * 不读 state、不写日志，屏幕外的输入全从参数进来。
 *
 * 两种模式（同一份枚举结果）：
 *   · 不传 seed/random：确定性排序，同样输入必得同样输出（单测、回放用）；
 *   · 传了 seed/random：按权重无放回抽取，seed 相同必得同一批，日志里记着 seed，
 *     事后拿它重跑就能复现抽到哪一格（B 版：枚举 + 约束表 + 权重）。
 *
 * 与规则第五节的偏差（只此一处，报告里写明了）：伪代码里亲和度是软门
 * （「affinity == 0 且存在亲和对」才剔），但第五节实算、第十一节逐条、第十三节的
 * 13/16 对都是按硬门算出来的；软门会让单段只读永远触发不了（每个 R 都补得上零亲和 A）。
 * 这里按硬门实现：亲和度 0 的动作格不进这一对的候选。
 */
import { isSelfReferential } from './gate.js';
import { SELF_OPTIMIZE_COOLDOWN_MS, normalizeMaterials } from './proposer.js';
import {
  MATERIAL_OBJECT_HINTS,
  MATERIAL_PRIMITIVE_HINTS,
  MOTIVATION_PRIMITIVES,
  MOTIVATION_WEIGHTS,
  SINGLE_READ_MOTIVATIONS,
  actionPrimitivesFor,
  objectHintsFor,
  primitiveHintsFor,
  readObjectsFor,
  solutionPoolIds,
} from './motivations.js';

/** 候选上限的兜底（规则 6.1 `proposer.maxCandidates`，默认 24）。 */
export const DEFAULT_MAX_CANDIDATES = 24;

/**
 * 九条原语（P1～P8 按规则第三节表序，P9 写方案是后加的、只许追加在末尾），
 * 顺序即表序，也是格号与排序的最后一道 tie-break。
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
  /*
   * P9 写方案：产出一份计划文档（`~/fatfish/plans/backlog-<编号>.md` 这类）。
   * 为什么单列一条原语而不是复用 edit-file：edit-file 的对象是「文件正文」，
   * 写方案的对象是「计划大纲」——它先由 backlog_list 挑票、读完再落文档，
   * 在 gate 里撤回模板（删掉这份新文档）和 files 类也不一样。两件事混一格，
   * backlog 类素材永远配不到「写方案」这一步上。
   */
  { id: 'draft', key: 'draft', label: '写方案', readonly: false, impact: 'local-write', reversibility: 'auto', entry: 'backlog_list → read → 写计划文档' },
];

/** 九类对象，顺序即规则第四节的列序（后加的类只许往末尾追加，别插队打乱已有格号）。`key` 是 yaml 配置里的写法。 */
export const OBJECT_KINDS = [
  { id: 'files', key: 'files', label: '文件' },
  { id: 'config', key: 'config', label: '配置' },
  { id: 'service', key: 'service', label: '服务' },
  { id: 'memory', key: 'memory', label: '记忆' },
  { id: 'ticket', key: 'ticket', label: '票' },
  { id: 'session', key: 'session', label: '会话' },
  { id: 'external-doc', key: 'externalDoc', label: '外部资料' },
  { id: 'external-repo', key: 'externalRepo', label: '外部仓库' },
  /*
   * 计划大纲：`plans/*.md` 这类「要做什么、分几步、怎么撤」的文档本身。
   * 只开给 inspect（读方案）与 draft（写方案）两条操作：改/删方案文档走
   * edit-file×files / delete×files——文档在磁盘上就是文件，没必要为它再开一条写原语。
   */
  { id: 'plan', key: 'plan', label: '计划大纲' },
];

/**
 * 合法组合的**唯一来源**：一张「操作 → 允许的对象类」约束表，不再手写稀疏矩阵。
 *
 * 为什么换成约束表：原来那张二维矩阵大部分格子是 `—`，靠人肉对齐行、列，
 * 加一类对象就要在九行里各改一处，漏一行不会报错、只会让那一格悄悄消失。
 * 现在只写「这条操作能碰哪几类对象」，运行时用 PRIMITIVES × OBJECT_KINDS 的笛卡尔积
 * 枚举，没列进来的组合一律不进抽取池。`PAIRING_MATRIX` 变成派生视图，只为兼容
 * gate.js 的 PAIR_SET 与既有单测，不再手写维护。
 *
 * 每条都写清依据，别让人猜「为什么删×计划大纲不算一格」。
 */
export const PAIR_CONSTRAINTS = [
  {
    primitive: 'inspect',
    objects: ['files', 'config', 'service', 'memory', 'ticket', 'session', 'external-doc', 'external-repo', 'plan'],
    why: '读格能看任何对象类：读方案文档就是读 plans/ 下的 *.md（inspect×plan）',
  },
  { primitive: 'edit-file', objects: ['files'], why: '改文件只碰文件正文；方案文档要改也走 files，不新开 edit-file×plan' },
  { primitive: 'edit-config', objects: ['config'], why: '配置只许落 config，写错类是 gate 的 GA2' },
  { primitive: 'service', objects: ['service'], why: '动服务只碰 service' },
  { primitive: 'memory-write', objects: ['memory'], why: '写记忆只碰 memory' },
  { primitive: 'delete', objects: ['files', 'external-repo'], why: '删只碰文件/外部仓库；删方案文档 = delete×files，不单列 delete×plan' },
  { primitive: 'outbound', objects: ['session'], why: '外部通信只碰会话' },
  { primitive: 'external-research', objects: ['external-doc', 'external-repo'], why: '外部检索只碰外部资料/外部仓库' },
  { primitive: 'draft', objects: ['plan'], why: '写方案只产出计划大纲：产出的文档落盘路径记在 plan.files，不单列 draft×files' },
];

/** 由约束表派生的矩阵视图（`inspect → [对象...]`），gate.js 的 PAIR_SET 与老单测接着用。 */
export const PAIRING_MATRIX = Object.fromEntries(
  PAIR_CONSTRAINTS.map((one) => [one.primitive, [...one.objects]]),
);

/** 矩阵摊平成 `primitive|objectKind` 集合，查一格合不合法就一次 has。 */
export const PAIR_SET = new Set(
  Object.entries(PAIRING_MATRIX).flatMap(([primitive, objects]) => objects.map((objectKind) => `${primitive}|${objectKind}`)),
);

/**
 * 读格（R）允许的原语：规则第二节 P1 / P8（`readonly: true` 那两条）。
 * 动作格（A）是其余七条（含后加的 P9 写方案）。两份集合与 gate 的 GA16 口径一致，由单测钉住。
 */
export const ROLE_READ = ['inspect', 'external-research'];
export const ROLE_ACTION = ['edit-file', 'edit-config', 'service', 'memory-write', 'delete', 'outbound', 'draft'];
const ROLE_READ_SET = new Set(ROLE_READ);
const ROLE_ACTION_SET = new Set(ROLE_ACTION);

/** 每拍最多取几个读格 R（规则第五节 N_R = 12；现在 R 一共 10 格，这一条剪不到东西）。 */
export const DEFAULT_MAX_READS = 12;

/** 每个读格最多配几个动作格 A（规则第五节 M_A = 2）。 */
export const MAX_ACTIONS_PER_READ = 2;

/*
 * 动机的权重 / 天然原语 / 单段读白名单全部来自 lib/motivations.js 那一张表，
 * 这里只做转出（老 import 路径 `from './grid.js'` 不变）。加一档动机别回来改这个文件。
 */
export { MOTIVATION_PRIMITIVES, MOTIVATION_WEIGHTS, SINGLE_READ_MOTIVATIONS };

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
  /*
   * 计划大纲的两条路（票面追加口径）：
   *   ① 读某个东西 → 出方案：ticket/files/config 三个读格都接 draft×plan。
   *      读票是「从工单池挑一条待办」，读文件/读配置是「读现状再写方案」。
   *   ② 读计划 → 再动手：plan 读格接 files/config/service 三个动作格（改文件、改配置、动服务）。
   * 不写 `ticket|files` 之类：票读格直接去改文件没有中间那步方案，属于跨级动作，
   * 硬配上会让「读票→乱改」这种组合混进抽取池。
   */
  'ticket|plan': 1,
  'files|plan': 1,
  'config|plan': 1,
  'plan|files': 1,
  'plan|config': 1,
  'plan|service': 1,
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

/* ══ 运行时枚举：组合编号、约束过滤、加权抽取 ══════════════════════════ */

/*
 * 素材正文关键词表也来自 lib/motivations.js（每档动机各带自己的关键词，
 * solution 那档只挂 plan，不挂 ticket）。这里转出的是全表并集，给不传动机的老调用方。
 */
export { MATERIAL_OBJECT_HINTS, MATERIAL_PRIMITIVE_HINTS };

/**
 * 一条素材的正文指向哪几类对象 / 哪几条操作。只进权重，不进合法性。
 *
 * 为什么要这一层：素材挂到哪个读格原来是纯 used/weight/index 的机械分配，
 * 正文写了什么都不影响——第 11 条素材（「用 backlog_list ... 写一份方案文档到
 * ~/fatfish/plans/backlog-<编号>.md」）每回都被 inspect×service 抢走，
 * 最后配成「读服务 → 改配置×config」。现在正文里出现「方案文档 / plans/ / 工单」
 * 这类词，就把对应格子的抽取权重抬起来，让它落进「读票 → 写方案×计划大纲」。
 * 认不出就中性（倍数 1），行为跟原来一样。
 *
 * 传了 motivation 就只用那一档的关键词（solution 只认 plan）；
 * 不传 / 认不出时用全表并集（老调用方的口径，改造前就是全动机共用一张表）。
 *
 * @param {string} text 素材正文
 * @param {string} [motivation] 素材的动机档位
 * @returns {{objects: Set<string>, primitives: Set<string>}}
 */
export function materialHintsOf(text, motivation = '') {
  const raw = String(text ?? '');
  const objects = new Set();
  const primitives = new Set();
  for (const rule of objectHintsFor(motivation)) if (rule.pattern.test(raw)) objects.add(rule.objectKind);
  for (const rule of primitiveHintsFor(motivation)) if (rule.pattern.test(raw)) primitives.add(rule.primitive);
  return { objects, primitives };
}

/** 素材挂在某一格上时的权重倍数：正文点名了这个对象类/操作 → 2.5，中性 → 1，点了别的 → 0.4。 */
export function materialFitFactor(hints, { objectKind = '', primitive = '' } = {}) {
  let factor = 1;
  if (hints?.objects?.size > 0) factor *= hints.objects.has(objectKind) ? 2.5 : 0.4;
  if (hints?.primitives?.size > 0) factor *= hints.primitives.has(primitive) ? 2.5 : 0.4;
  return factor;
}

/**
 * 全笛卡尔积的宽度：`PRIMITIVES × OBJECT_KINDS`。格号按这个序算，
 * 后加的原语/对象只许追加在末尾，已有格号就不会漂。
 */
export const CELL_GRID_WIDTH = OBJECT_KINDS.length;

/**
 * 一格的稳定编号：`X01`..`X<PRIMITIVES.length × OBJECT_KINDS.length>`。
 * 按「原语序 × 对象序」算，跳过没意义的组合也**不跳号**——
 * 编号一旦跳号，日志里旧格号就会跟新格号撞车，事后没法对。
 * @param {string} primitiveId 原语 id（`edit-file`）
 * @param {string} objectKindId 对象类 id（`files`）
 * @returns {string} `X12` 或空串（认不出的 id）
 */
export function cellIdOf(primitiveId, objectKindId) {
  const p = PRIMITIVES.findIndex((one) => one.id === primitiveId);
  const o = OBJECT_KINDS.findIndex((one) => one.id === objectKindId);
  if (p < 0 || o < 0) return '';
  return `X${String(p * CELL_GRID_WIDTH + o + 1).padStart(2, '0')}`;
}

/**
 * 运行时枚举所有合法的「操作×对象」格。
 *
 * 合法性只有一条：这一格在 PAIR_CONSTRAINTS 里（操作 → 允许的对象类）。
 * 开关（配置里的 primitives / objects）默认按白名单判——显式 true 才开，
 * 跟 buildGrid 一样；要列全量清单（报告/测试用）就传 `includeDisabled: true`。
 *
 * @param {{primitives?: Record<string, boolean>, objects?: Record<string, boolean>, includeDisabled?: boolean}} [input]
 * @returns {Array<{id: string, role: 'read'|'action', primitive: object, objectKind: object}>}
 */
export function enumerateCells({ primitives = {}, objects = {}, includeDisabled = false } = {}) {
  const cells = [];
  for (const primitive of PRIMITIVES) {
    const allowed = new Set(PAIRING_MATRIX[primitive.id] ?? []);
    const role = ROLE_READ_SET.has(primitive.id) ? 'read' : (ROLE_ACTION_SET.has(primitive.id) ? 'action' : '');
    if (!role) continue;
    for (const objectKind of OBJECT_KINDS) {
      if (!allowed.has(objectKind.id)) continue;
      if (!includeDisabled) {
        if (primitives?.[primitive.key] !== true) continue;
        if (objects?.[objectKind.key] !== true) continue;
      }
      cells.push({ id: cellIdOf(primitive.id, objectKind.id), role, primitive, objectKind });
    }
  }
  return cells;
}

/** 近期降权的窗口：recentCombos 里最多记 10 条，只取最近的 5 条算惩罚。 */
export const RECENT_COMBO_WINDOW = 5;
/** 最近窗口内出现过一次的对，权重 ×0.25（再出现一次再乘，最低压到 MIN_PICK_WEIGHT）。 */
export const RECENT_COMBO_PENALTY = 0.25;
/** 上一拍用过的动作格：权重 ×0.1（比「最近提过」更狠，动作格本来就不许连拍）。 */
export const LAST_ACTION_CELL_PENALTY = 0.1;
/** 任何一对的权重下限：再冷门也别让权重归零、整格抽不到。 */
export const MIN_PICK_WEIGHT = 0.02;

/**
 * mulberry32：32 位种子的可复现伪随机。为什么自己写：
 * 线上要「同一 seed 必得同一格」，`Math.random()` 没法复现；加密级 PRNG
 * 在这里是杀鸡用牛刀，还要额外依赖。
 *
 * @param {number|string} seed
 * @returns {() => number} [0, 1)
 */
export function createSeededRandom(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按权重无放回抽 `count` 个。返回抽中的元素（顺序即抽中顺序，第一个就是这一拍实际用的）。
 * @template T
 * @param {T[]} items
 * @param {(item: T) => number} weightOf
 * @param {() => number} random
 * @param {number} count
 * @returns {T[]}
 */
export function weightedPick(items, weightOf, random, count) {
  const pool = items.map((item) => ({ item, weight: Math.max(MIN_PICK_WEIGHT, Number(weightOf(item)) || 0) }));
  const picked = [];
  const limit = Math.min(Math.max(0, Math.floor(count)), pool.length);
  for (let i = 0; i < limit; i += 1) {
    const total = pool.reduce((sum, one) => sum + one.weight, 0);
    let roll = random() * total;
    let index = pool.length - 1;
    for (let j = 0; j < pool.length; j += 1) {
      roll -= pool[j].weight;
      if (roll <= 0) { index = j; break; }
    }
    picked.push(pool[index].item);
    pool.splice(index, 1);
  }
  return picked;
}

/** 原语别名 → 规则 id（recentCombos 里可能存 `P6` / `delete` / 配置键 `editFile`）。 */
const PRIMITIVE_ALIASES = new Map();for (let i = 0; i < PRIMITIVES.length; i += 1) {
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
 * @param {Array<string|{id?: string}>} [input.solutionPool] 本拍「已定方案」池（引擎从 backlog
 *   读好传进来；grid 保持纯函数，不碰 sqlite）。solution 素材在池为空时整条不进候选：
 *   没有可执行的方案，这条素材只能配出「读方案 → 瞎改」的空格。
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
  solutionPool = [],
  /*
   * 随机抽取（B 版：枚举 + 约束表 + 权重）：
   *   不传 seed 也不传 random → 确定性路径（排序取前 N），单测/回放靠它复现旧行为；
   *   传了 → 走加权随机，seed 相同必得同一格。线上每拍生成一个 seed 记日志与 plans.jsonl。
   */
  seed = null,
  random = null,
} = {}) {
  const limit = toMaxCandidates(maxCandidates);
  const slotLimit = toLimit(materialSlots, MAX_SLOTS_PER_MATERIAL);
  const readLimit = toLimit(maxReads, DEFAULT_MAX_READS);
  const actionLimit = toLimit(maxActionsPerRead, MAX_ACTIONS_PER_READ);
  const nowMs = now instanceof Date ? now.getTime() : toTimestamp(now);
  const randomized = typeof random === 'function' || seed !== null && seed !== undefined;
  const rng = typeof random === 'function' ? random : (randomized ? createSeededRandom(seed) : null);

  // 素材池：沿用线上同一套剔条口径（空 text、不在档位里的 motivation）。
  const { materials: rawPool } = normalizeMaterials(materials);
  if (rawPool.length === 0) return [];
  /*
   * 「已定方案」池为空时，solution 素材整条剔掉：
   * 没有可执行的方案，它只能配出「读方案 → 瞎改」，不如把这一拍让给别的动机。
   * 池非空时照常进枚举，具体挑哪一条由 stage2 决定、由 gate 的 GA18 核。
   */
  const solutionIds = solutionPoolIds(solutionPool);
  const pool = solutionIds.length > 0
    ? rawPool
    : rawPool.filter((item) => item.motivation !== 'solution');
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
      // 正文倾向（方案文档 / 工单 …）：只影响抽取权重与「挂哪个读格」，不进合法性。
      // 按动机取关键词表：solution 只认 plan，别被正文里的 backlog_list / 工单池带去 ticket 读格。
      hints: materialHintsOf(item.text, item.motivation),
      // 这档素材只许挂哪几类读格（空 = 不限）。solution 只挂 plan：它干的是「读方案」。
      readObjects: readObjectsFor(item.motivation),
      // 这档素材只许配哪几条动作原语（空 = 不限）。solution 只许 edit-file / edit-config。
      actionPrimitives: actionPrimitivesFor(item.motivation),
    }));
  if (live.length === 0) return [];

  /*
   * recentCombos 只认「对」。老的一格格式（上一版的记账口径）在 normalizeComboKey
   * 里就返回空串，这里自然丢掉——规则第七节：旧记录直接重来，别当成对补一个动作。
   * 对象新鲜度按 R 的对象算（第六节），所以两个用途读同一份记录。
   */
  const recentPairs = new Set();
  /*
   * 最近窗口里每对出现过几次：随机路径按次数降权（不硬剔）。
   * recentCombos 旧的在前、新的在尾，只取最后 RECENT_COMBO_WINDOW 条——
   * 10 条是「记账上限」，5 条才是「近期」口径，隔了 6 拍以上的重复不该再罚。
   */
  const recentPairCount = new Map();
  const objectSeen = new Map();
  const normalizedCombos = [];
  for (const item of Array.isArray(recentCombos) ? recentCombos : []) {
    const key = normalizeComboKey(item);
    if (!key) continue;
    normalizedCombos.push(key);
    recentPairs.add(key);
    const readPart = key.split(ARROW_SPLIT)[0];
    const readObject = readPart.slice(readPart.indexOf('|') + 1);
    objectSeen.set(readObject, (objectSeen.get(readObject) ?? 0) + 1);
  }
  for (const key of normalizedCombos.slice(-RECENT_COMBO_WINDOW)) {
    recentPairCount.set(key, (recentPairCount.get(key) ?? 0) + 1);
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
   * 顺序按格池生成序，格内挑法：**正文倾向先对**（素材点名了这个对象类就优先挂这格，
   * 没点名算中性），然后才是用得最少的、动机权重高的、素材在池里靠前的。
   * 加这一道是为了让「写方案文档到 plans/」那条 backlog 素材挂到 ticket/plan 读格上；
   * 中性素材的 fit 全是 1，排序与改造前逐字一致（老快照照旧过）。
   */
  /*
   * 读格的挂素材顺序：**有素材点名要它的格先挂**，其余仍按格池序。
   * 不这么排的话，倾向只在「同一条素材抢多格」时起作用——素材额度先被前面的
   * files/config 格吃掉，写到 plans/ 的那条素材根本轮不到 ticket/plan 读格。
   */
  const hintMatches = (cell) => live.filter((material) => material.hints.objects.has(cell.objectKind.id)).length;
  const assignOrder = [...readCells].sort((a, b) => hintMatches(b) - hintMatches(a) || a.seq - b.seq);

  const keptReads = [];
  for (const cell of assignOrder) {
    const usable = live
      .filter((material) => material.used < slotLimit
        && (material.readObjects.length === 0 || material.readObjects.includes(cell.objectKind.id)))
      .map((material) => ({
        material,
        fit: material.hints.objects.size === 0
          ? 1
          : (material.hints.objects.has(cell.objectKind.id) ? 2 : 0),
      }))
      .sort((a, b) => b.fit - a.fit
        || a.material.used - b.material.used
        || b.material.weight - a.material.weight
        || a.material.index - b.material.index);
    const material = usable[0]?.material;
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
   * 每个 R 配 A：
   *   确定性路径（没传 seed）——先剔「对级冷却」（这一对提过）与「动作格连续两拍冷却」，
   *   再按亲和度与原语序取前 M_A；行为与改造前逐字一致。
   *   随机路径（传了 seed）——不硬剔：近期提过的对按次数降权、动作格上一拍用过也降权，
   *   所有合法对都进池，最后按权重抽（`pickWeightOf`）。
   * 亲和度 0 的不成对（见文件头），所以配不出 A 的 R 才轮到单段读。
   */
  const rows = [];
  let single = null;
  for (const { cell: readCell, material, freshness } of readsTaken) {
    const usable = [];
    for (const actionCell of actionCells) {
      // 动机自带动作面时先过这一道：stage1 就别给出会被 GA19 拦下的格子
      if (material.actionPrimitives.length > 0
        && !material.actionPrimitives.includes(actionCell.primitive.id)) continue;
      const pairKey = `${cellKey(readCell)}${COMBO_ARROW}${cellKey(actionCell)}`;
      if (!randomized && recentPairs.has(pairKey)) continue;
      if (!randomized && cooledActions.has(cellKey(actionCell))) continue;
      const affinity = affinityOf(readCell.objectKind.id, actionCell.objectKind.id);
      if (affinity < 1) continue;
      usable.push({ actionCell, affinity });
    }
    usable.sort((a, b) => b.affinity - a.affinity || a.actionCell.seq - b.actionCell.seq);
    const selected = randomized ? usable : usable.slice(0, actionLimit);
    if (selected.length === 0) {
      /*
       * 单段只读：只在 hygiene / status 下开口，全拍最多一格（规则第四节第 1、2、5 条）。
       * 它同样进 recentCombos，键是箭尾留空的 `inspect|session→`；记过就这一拍不再补，
       * 否则同一格会连着反复被选中、反复读。
       */
      const singleKey = `${cellKey(readCell)}${COMBO_ARROW}`;
      const blocked = !single && (!recentPairs.has(singleKey) || randomized);
      if (blocked && SINGLE_READ_MOTIVATIONS.includes(material.motivation)) {
        single = {
          read: readCell,
          action: null,
          material,
          freshness,
          affinity: 0,
          fit: 1,
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
        // 素材正文点名了这格的对象/操作 → 抽取权重 ×2.5，点名了别的 → ×0.4，中性 ×1
        fit: materialFitFactor(material.hints, {
          objectKind: actionCell.objectKind.id,
          primitive: actionCell.primitive.id,
        }),
        /*
         * 确定性路径的排序分（第六节）：动机权重×10 + 对象新鲜度 + 同对象 3 + 有产出原语 2 + 亲和对 1。
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
   * 随机路径不用这六步：排序只决定权重相同时的抽取顺序，抽取本身按权重。
   */
  const primitiveSeq = new Map(PRIMITIVES.map((p, i) => [p.id, i]));
  const objectSeq = new Map(OBJECT_KINDS.map((o, i) => [o.id, i]));
  const actionOrder = (row) => (row.action ? primitiveSeq.get(row.action.primitive.id) : PRIMITIVES.length);
  const pairKeyOf = (row) => (row.action
    ? `${cellKey(row.read)}${COMBO_ARROW}${cellKey(row.action)}`
    : `${cellKey(row.read)}${COMBO_ARROW}`);

  /**
   * 一对的抽取权重：动机权重 × 近期降权 × 动作格冷却 × 同对象加成 × 素材正文倾向。
   * 数值都在上面几个常量里，改参数只动那一处。
   */
  const pickWeightOf = (row) => {
    let weight = row.material.weight || 1;
    if (!row.action) weight *= 0.5; // 单段读是逃生口，不跟两段对抢
    weight *= RECENT_COMBO_PENALTY ** (recentPairCount.get(pairKeyOf(row)) ?? 0);
    if (row.action && cooledActions.has(cellKey(row.action))) weight *= LAST_ACTION_CELL_PENALTY;
    if (row.affinity >= 2) weight *= 1.5;
    weight *= row.action
      ? row.fit
      : materialFitFactor(row.material.hints, {
          objectKind: row.read.objectKind.id,
          primitive: row.read.primitive.id,
        });
    return weight;
  };

  let ordered;
  if (randomized) {
    /*
     * B 版抽取：按权重无放回抽 limit 个，抽中顺序就是候选顺序，第一个即这一拍实际用的。
     * 随机源由调用方给（seed 或 random 函数）；同一 seed 必得同一批，
     * 事后拿日志里的 seed 重跑就能复现抽到了哪一格。
     */
    ordered = weightedPick(rows, pickWeightOf, rng, limit);
  } else {
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
     * 上一拍用过的素材整组排到队尾（只在确定性路径做：随机路径靠素材权重与近期降权够）。
     * 为什么要这一段：pick 只取第一对，同一素材连着两拍当 C01 会被 gate 的 GA13
     * 判「同一素材连续两拍」把 do 降级成 ask，用户那边每分钟被问一次。
     * 只排后不剔除：素材池窄的时候（只有一两条）候选数量一对不少。
     */
    const lastText = String(lastMaterial ?? '').trim();
    ordered = lastText
      ? [
          ...rows.filter((one) => one.material.text !== lastText),
          ...rows.filter((one) => one.material.text === lastText),
        ]
      : rows;
  }

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
      /*
       * 两格的稳定组合号（`X12`）：按「原语序 × 对象序」算，随日志一起记，
       * 事后拿格号就能定位是哪一格，不用再靠原语×对象的名字拼。
       */
      readCellId: cellIdOf(read.primitive, read.objectKind),
      actionCellId: action ? cellIdOf(action.primitive, action.objectKind) : '',
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
