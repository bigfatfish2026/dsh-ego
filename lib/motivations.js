/**
 * 动机注册表：一档动机只在这里定义一次。
 *
 * 一档动机原来散在五处：`proposer.js` 的白名单、`grid.js` 的权重 / 原语 / 素材关键词、
 * 外加 `grid.js` 与 `gate.js` 各抄一份的单段只读白名单。加一档要改五处，漏一处不会报错，
 * 只会让那一档的候选悄悄少掉或单段读被误拦。现在这些消费方全从本表派生：
 *
 *   · `proposer.js`  → `PROPOSER_MOTIVATIONS`（配置白名单，未知值剔条）
 *   · `grid.js`      → `MOTIVATION_WEIGHTS` / `MOTIVATION_PRIMITIVES` / `SINGLE_READ_MOTIVATIONS` / 素材关键词
 *   · `gate.js`      → `SINGLE_READ_MOTIVATIONS`（GA15 的单段读白名单）
 *
 * 本文件零依赖、只有数据与纯函数：任何一层都可以 import，不会成环，也不会把 fs 带进 gate。
 *
 * 加一档动机的步骤（照做就不会漏）：
 *   1. 在 `MOTIVATIONS` 里加一条（id / weight / primitives / singleRead / description / 关键词）；
 *   2. `cordis.patch.yml` 与 profile 的 `proposer.materials` 里加一条同类素材；
 *   3. 这档如果要专属的闸，去 `gate.js` 的 `STAGE2_MOTIVATION_RULES` 注册，别在 checkStage2Plan 里加 if。
 */

/* ══ 素材正文关键词（只影响抽取权重与「挂哪个读格」，不进合法性）══════════ */

/**
 * 通用关键词：素材正文里出现这些词，就把对应对象类 / 原语那一侧的抽取权重抬起来。
 * 七档老动机共用这一份，行为与改造前逐字一致（原来就是全动机共用的两张表）。
 */
const PLAN_DOC_HINT = Object.freeze({
  objectKind: 'plan',
  pattern: /方案文档|计划文档|计划大纲|plans\/|backlog-|outline/i,
});
const TICKET_HINT = Object.freeze({
  objectKind: 'ticket',
  pattern: /工单|票号|票台|编号|backlog_list|dispatch_(?:list|open|show|report)/i,
});
const DRAFT_HINT = Object.freeze({ primitive: 'draft', pattern: /写一份方案|写方案|起草方案|方案文档/i });

const SHARED_OBJECT_HINTS = Object.freeze([PLAN_DOC_HINT, TICKET_HINT]);
const SHARED_PRIMITIVE_HINTS = Object.freeze([DRAFT_HINT]);

/**
 * solution 专用关键词：只挂 plan，**不挂 ticket**。
 * 为什么：ticket 读格接不到「读票 → 改文件」这一对（`grid.js` 的亲和表写明 ticket|files
 * 是跨级动作，亲和 0），素材一旦被 ticket 读格抢走，整条素材就配不出能落地的动作格。
 * 这条只认「已定方案 / 方案正文」这类词，把素材稳稳挂到 inspect×plan 上。
 */
const SOLUTION_SOURCE_HINT = Object.freeze({
  objectKind: 'plan',
  pattern: /已定方案|取方案|落地方案|执行方案|方案正文/i,
});

/** 已定方案在工单池里的状态值（dsh-backlog 的 BACKLOG_STATUSES 之一，那边是唯一写入方）。 */
export const SOLUTION_STATUS = '已定方案';

/** 已定方案的 id 形状：`bl-<base36 时间戳>-<4 位随机>`（dsh-backlog 的 newId 口径）。 */
export const SOLUTION_BL_ID_RE = /^bl-[a-z0-9]+-[a-z0-9]{4}$/;

/** 从一段正文里认 bl-id（不锚定：step1.read 常写成「读了 plans/backlog-bl-xxx.md」）。 */
export const SOLUTION_BL_ID_SCAN = /bl-[a-z0-9]+-[a-z0-9]{4}/i;

/**
 * 方案里该去哪些字段找 bl-id：object.value → step1.read → plan.files 逐个找。
 * gate 的 GA18 与 backlog-pool 的池项解析共用这一份顺序，别两边各写一遍。
 * @param {object} plan parseStage2Plan 的 plan
 * @returns {Array<[string, unknown]>} `[字段名, 值]`，字段名给日志 / why 文案用
 */
export function solutionIdFieldsOf(plan) {
  return [
    ['object.value', plan?.object?.value],
    ['step1.read', plan?.step1?.read],
    ...(Array.isArray(plan?.plan?.files) ? plan.plan.files.map((one, i) => [`plan.files[${i}]`, one]) : []),
  ];
}

/**
 * 方案里写的第一个 bl-id 及它来自哪个字段。
 * @param {object} plan
 * @returns {{id: string, field: string}|null}
 */
export function solutionIdInPlan(plan) {
  for (const [field, value] of solutionIdFieldsOf(plan)) {
    const hit = String(value ?? '').match(SOLUTION_BL_ID_SCAN);
    if (hit) return { id: hit[0], field };
  }
  return null;
}

/* ══ 动机表：唯一来源 ═══════════════════════════════════════════════ */

/**
 * @typedef {object} Motivation
 * @property {string} id 素材配置里的 motivation 值
 * @property {number} weight 抽取权重（只影响排序，不决定格子合不合法）
 * @property {string[]} primitives 这档天然想用的原语（只用于 R 排序的 `fits`，不当合法性）
 * @property {boolean} singleRead 允不允许出「单段只读」那一格（grid 与 gate 共用）
 * @property {string} description 一句话说明，给文档与日志用
 * @property {string[]} [readObjects] 可选：只许挂到这几类读格上（缺省 = 不限，老动机的行为）
 * @property {string[]} [actionPrimitives] 可选：这一档只许配这几条动作原语（缺省 = 不限）
 * @property {Array<{objectKind: string, pattern: RegExp}>} objectHints 这档素材正文的对象关键词
 * @property {Array<{primitive: string, pattern: RegExp}>} primitiveHints 这档素材正文的原语关键词
 */

/** @type {ReadonlyArray<Motivation>} */
export const MOTIVATIONS = Object.freeze([
  {
    id: 'backlog',
    weight: 3,
    primitives: ['inspect', 'edit-file', 'edit-config', 'service', 'memory-write', 'delete', 'external-research', 'draft'],
    singleRead: false,
    description: '手上还没收尾的待办：读工单/方案，落到文件或配置，必要时先写方案',
    objectHints: SHARED_OBJECT_HINTS,
    primitiveHints: SHARED_PRIMITIVE_HINTS,
  },
  {
    id: 'hygiene',
    weight: 1,
    primitives: ['inspect', 'edit-file', 'edit-config', 'delete'],
    singleRead: true,
    description: '清理类：仓库里的 bug、过期 TODO、没人用的配置、陈旧备份',
    objectHints: SHARED_OBJECT_HINTS,
    primitiveHints: SHARED_PRIMITIVE_HINTS,
  },
  {
    id: 'sync',
    weight: 2,
    primitives: ['inspect', 'external-research'],
    singleRead: false,
    description: '本地仓库与远端是否同步（该推的、该拉的）',
    objectHints: SHARED_OBJECT_HINTS,
    primitiveHints: SHARED_PRIMITIVE_HINTS,
  },
  {
    id: 'social',
    weight: 2,
    primitives: ['inspect', 'outbound'],
    singleRead: false,
    description: '邮箱 / 消息通知里攒着没看的东西',
    objectHints: SHARED_OBJECT_HINTS,
    primitiveHints: SHARED_PRIMITIVE_HINTS,
  },
  {
    id: 'memory',
    weight: 2,
    primitives: ['inspect', 'memory-write'],
    singleRead: false,
    description: '长期记忆里的新条目与互相矛盾之处',
    objectHints: SHARED_OBJECT_HINTS,
    primitiveHints: SHARED_PRIMITIVE_HINTS,
  },
  {
    id: 'status',
    weight: 3,
    primitives: ['inspect', 'service'],
    singleRead: true,
    description: '宿主状态：温度、内存、磁盘、服务、日志里的异常',
    objectHints: SHARED_OBJECT_HINTS,
    primitiveHints: SHARED_PRIMITIVE_HINTS,
  },
  {
    id: 'self',
    weight: 1,
    primitives: ['inspect', 'edit-file', 'edit-config'],
    singleRead: false,
    description: '优化 dsh-ego 插件自己（要求写成 文件路径:行号 + 要跑的测试）',
    objectHints: SHARED_OBJECT_HINTS,
    primitiveHints: SHARED_PRIMITIVE_HINTS,
  },
  {
    id: 'solution',
    weight: 3,
    primitives: ['inspect', 'edit-file', 'edit-config'],
    singleRead: false,
    description: '取工单池里一条「已定方案」并落地它的第一步（只改文件/配置，可自动撤回）',
    // 只挂 plan：见 SOLUTION_SOURCE_HINT 的注释，挂 ticket 会让素材配不出动作格
    objectHints: Object.freeze([SOLUTION_SOURCE_HINT]),
    primitiveHints: Object.freeze([]),
    // 只许挂 inspect×plan：这条素材干的是「读方案」，挂到 files/config 读格上
    // 会变成「读某个文件 → 改文件」，step1 里就没有方案正文可言了。
    readObjects: Object.freeze(['plan']),
    // 动作格只许改文件 / 改配置：stage1 就不给 draft×plan（同对象加成会把它排第一）。
    // gate 的 GA19 是第二道防线，别让第一道先放一条会被拦的候选出来白烧一次重写。
    actionPrimitives: Object.freeze(['edit-file', 'edit-config']),
  },
]);

/** 动机 id 列表，顺序即注册顺序（`PROPOSER_MOTIVATIONS` 直接用它）。 */
export const MOTIVATION_IDS = Object.freeze(MOTIVATIONS.map((one) => one.id));

/** `id -> 动机`，认不出返回 undefined。 */
export const MOTIVATION_BY_ID = new Map(MOTIVATIONS.map((one) => [one.id, one]));

/** `id -> 权重`：grid 的抽取权重表。 */
export const MOTIVATION_WEIGHTS = Object.freeze(
  Object.fromEntries(MOTIVATIONS.map((one) => [one.id, one.weight])),
);

/** `id -> 天然原语`：只用于 R 排序的 fits，不当合法性（口径见 grid.js 的注释）。 */
export const MOTIVATION_PRIMITIVES = Object.freeze(
  Object.fromEntries(MOTIVATIONS.map((one) => [one.id, Object.freeze([...one.primitives])])),
);

/**
 * 允许出「单段只读」的动机：全项目只有这一份，grid 与 gate 都 import 它。
 * （原先 grid.js 与 gate.js 各抄一份 `['hygiene', 'status']`，加档必漏一边。）
 */
export const SINGLE_READ_MOTIVATIONS = Object.freeze(
  MOTIVATIONS.filter((one) => one.singleRead).map((one) => one.id),
);

/** 所有动机关键词的并集（素材没写动机时按它判，保持改造前的全表口径）。 */
export const MATERIAL_OBJECT_HINTS = Object.freeze(
  [...new Set(MOTIVATIONS.flatMap((one) => one.objectHints))],
);
export const MATERIAL_PRIMITIVE_HINTS = Object.freeze(
  [...new Set(MOTIVATIONS.flatMap((one) => one.primitiveHints))],
);

/** 一档动机的对象/原语关键词表；认不出的动机回落全表（老调用方不传动机时的行为）。 */
export function objectHintsFor(motivation) {
  const entry = MOTIVATION_BY_ID.get(String(motivation ?? '').trim());
  return entry ? entry.objectHints : MATERIAL_OBJECT_HINTS;
}

export function primitiveHintsFor(motivation) {
  const entry = MOTIVATION_BY_ID.get(String(motivation ?? '').trim());
  return entry ? entry.primitiveHints : MATERIAL_PRIMITIVE_HINTS;
}

/** 这档动机只许配哪几条动作原语；空数组 = 不限（老动机）。 */
export function actionPrimitivesFor(motivation) {
  const entry = MOTIVATION_BY_ID.get(String(motivation ?? '').trim());
  const list = Array.isArray(entry?.actionPrimitives) ? entry.actionPrimitives : [];
  return list;
}

/** 这档动机只许挂哪几类读格；空数组 = 不限（老动机）。 */
export function readObjectsFor(motivation) {
  const entry = MOTIVATION_BY_ID.get(String(motivation ?? '').trim());
  const list = Array.isArray(entry?.readObjects) ? entry.readObjects : [];
  return list;
}

/** 是不是「已定方案」这档（gate 的 GA18/19/20 与提示词用它判，别各处写字符串）。 */
export function isSolutionMotivation(motivation) {
  return String(motivation ?? '').trim() === 'solution';
}

/**
 * 已定方案池归一成 id 数组：池项可以是字符串，也可以是 `{id}`（backlog-pool 的取池结果）。
 * 认不出的项直接丢掉——gate 只拿它做「在不在池里」的一次查表。
 * @param {Array<string|{id?: string}|null|undefined>} [pool]
 * @returns {string[]}
 */
export function solutionPoolIds(pool) {
  const list = Array.isArray(pool) ? pool : [];
  return [...new Set(
    list
      .map((one) => (typeof one === 'string' ? one.trim() : String(one?.id ?? '').trim()))
      .filter(Boolean),
  )];
}
