/**
 * replay 变差率按「改动规模」分层后的权重系数。
 *
 * 为什么要分层：combo 历史把「大改」和「小修小补」混在一个账本里。大改本来就更容易被
 * gate 判变差（碰的文件多、动的面宽），一路被拒下来，那一对的系数就被压到 0.4，
 * 于是永远抽不到它——这就是「大改被小修小补的统计压死」。现在同一对的历史按规模分三档，
 * 每档单独算变差率，权重只看这一对「最近一次落盘方案」所在档的账。
 *
 * 三档（判据是纯函数，边界都在下面导出，单测直接踩）：
 *   small  files ≤ 1 且 writes ≤ 1
 *   medium 其余
 *   large  files ≥ 3，或 plan.steps 里出现 delete / service / outbound 任一
 *          （steps 的写法可能是 `P6×files`、`delete|files`、`delete×files`，都认）
 * 判定顺序：先判 large，再判 small，剩下 medium——所以「3 个文件但只写 1 处」算 large。
 *
 * 系数：
 *   worse 率 < 该档阈值 → 1（不降权）
 *   否则 factor = clamp(1 - worse 率, 该档下限, 1)
 *   small  阈值 35%，下限 0.4（与原口径一致）
 *   medium 阈值 35%，下限 0.6
 *   large  阈值 50%，下限 0.8（放宽，别让大改被压死）
 *
 * 与 combo 系数合并：`clamp(combo × scale, 0.3, 2.0)`，顺序固定「先 combo 后 scale」，
 * 乘完再整体夹；常量在 COMBINED_FACTOR_MIN / COMBINED_FACTOR_MAX。
 *
 * 这个文件只放纯函数：不读盘、不 import replay（replay.js 反过来 import 这里），
 * 免得 grid → change-scale → replay → grid 绕成环。读盘与重放在 replay.js 的
 * loadScaleHistory 里，按 plans 文件 mtime+size 缓存。
 */

/** 三档名字，顺序即从轻到重 */
export const CHANGE_SCALES = Object.freeze(['small', 'medium', 'large']);

/** small 档的 files 上限（含） */
export const SMALL_MAX_FILES = 1;
/** small 档的 writes 上限（含）：intent.impact 的 paths + services + remotes 条数 */
export const SMALL_MAX_WRITES = 1;
/** large 档的 files 下限（含） */
export const LARGE_MIN_FILES = 3;
/** steps 里出现这几条原语就按 large 算（不可逆 / 碰服务 / 出网） */
export const LARGE_STEP_PRIMITIVES = Object.freeze(['delete', 'service', 'outbound']);

/** 每档的降权下限 */
export const SCALE_FACTOR_FLOOR = Object.freeze({ small: 0.4, medium: 0.6, large: 0.8 });
/** 每档「不降权」的变差率阈值（严格小于才不降权） */
export const SCALE_WORSE_THRESHOLD = Object.freeze({ small: 0.35, medium: 0.35, large: 0.5 });

/** 与 combo 系数相乘后的整体下限 */
export const COMBINED_FACTOR_MIN = 0.3;
/** 与 combo 系数相乘后的整体上限 */
export const COMBINED_FACTOR_MAX = 2.0;

/** `P4` / `P6` / `P7` 与配置里的驼峰写法都归到规则 id */
const STEP_ALIASES = Object.freeze({
  p1: 'inspect',
  p2: 'edit-file',
  p3: 'edit-config',
  p4: 'service',
  p5: 'memory-write',
  p6: 'delete',
  p7: 'outbound',
  p8: 'external-research',
  p9: 'draft',
  service: 'service',
  delete: 'delete',
  outbound: 'outbound',
});

/** 一条 step（`P6×files` / `delete|files` / `P6`）→ 原语 id；认不出返回空串 */
export function stepPrimitiveOf(step) {
  const text = String(step ?? '').trim();
  if (!text) return '';
  const head = text.split(/[×|:/]/, 1)[0].trim().toLowerCase();
  if (!head) return '';
  return STEP_ALIASES[head] ?? (/^[a-z][a-z-]*$/.test(head) ? head : '');
}

/** 一份方案里的文件去重后几条（plan.plan.files 与 step2.files 合并；同一条算一次） */
function filesOf(plan) {
  const files = new Set();
  for (const list of [plan?.plan?.files, plan?.step2?.files]) {
    for (const one of Array.isArray(list) ? list : []) {
      const text = String(one ?? '').trim();
      if (text) files.add(text);
    }
  }
  return files;
}

/** writes 的口径：intent.impact 里 paths / services / remotes 的非空条数（不重复计） */
function writesOf(plan) {
  const impact = plan?.intent?.impact ?? {};
  let count = 0;
  for (const key of ['paths', 'services', 'remotes']) {
    const list = Array.isArray(impact?.[key]) ? impact[key] : [];
    count += new Set(list.map((one) => String(one ?? '').trim()).filter(Boolean)).size;
  }
  return count;
}

/**
 * 一条 plans.jsonl 记录（或一份 plan 原文）按改动规模判档。
 *
 * @param {object} record 记录（读 record.plan）或直接给 plan 原文
 * @returns {'small'|'medium'|'large'}
 */
export function changeScaleOf(record) {
  // 调用方给的是整条记录还是 plan 原文：有 plan 字段就往下取，否则当 plan 用
  const plan = record && typeof record === 'object' && record.plan && typeof record.plan === 'object'
    ? record.plan
    : (record ?? {});
  const fileCount = filesOf(plan).size;
  const writes = writesOf(plan);
  const steps = Array.isArray(plan?.plan?.steps) ? plan.plan.steps : [];
  const primitives = new Set(steps.map(stepPrimitiveOf).filter(Boolean));
  if (fileCount >= LARGE_MIN_FILES || LARGE_STEP_PRIMITIVES.some((one) => primitives.has(one))) return 'large';
  if (fileCount <= SMALL_MAX_FILES && writes <= SMALL_MAX_WRITES) return 'small';
  return 'medium';
}

/**
 * 一档的变差率与系数。
 *
 * @param {{total?: number, worse?: number}|null|undefined} stat 该档的重放统计
 * @param {'small'|'medium'|'large'} scale
 * @returns {number} 1 = 不降权；否则落在该档下限与 1 之间
 */
export function scaleFactorOfStat(stat, scale) {
  const floor = SCALE_FACTOR_FLOOR[scale];
  const threshold = SCALE_WORSE_THRESHOLD[scale];
  if (floor === undefined || threshold === undefined) return 1;
  const total = Math.max(0, Number(stat?.total) || 0);
  if (total <= 0) return 1;
  const worse = Math.min(total, Math.max(0, Number(stat?.worse) || 0));
  const rate = worse / total;
  if (rate < threshold) return 1;
  return Math.min(1, Math.max(floor, 1 - rate));
}

/**
 * 一对的 scale 系数：只看这一对**最近一次**落盘方案所在档的账。
 *
 * 为什么用「最近一次的档」而不是三档混合：grid 抽取在 stage2 之前，还不知道这次要写多大，
 * 唯一能确定的就是这一对最近一次产出的规模；按它取档，既保住分层（小改的败绩不再进
 * 大改的账），结果又是确定性的、可以用真数据复现。
 *
 * @param {{byScale?: object, lastScale?: string}|null|undefined} entry loadScaleHistory().table 的一项
 * @param {string} [scale] 不传就用 entry.lastScale
 * @returns {number}
 */
export function scaleFactorOf(entry, scale = entry?.lastScale) {
  if (!entry || typeof entry !== 'object') return 1;
  const tier = SCALE_FACTOR_FLOOR[scale] === undefined ? '' : scale;
  if (!tier) return 1;
  return scaleFactorOfStat(entry?.byScale?.[tier], tier);
}

/**
 * combo 系数 × scale 系数，乘完整体 clamp(0.3, 2.0)。
 * 顺序固定「先 combo 后 scale」，最后夹一次；哪一边没历史就按 1 算。
 *
 * @param {number} comboFactor
 * @param {number} [scaleFactor]
 * @returns {number}
 */
export function combinedFactor(comboFactor, scaleFactor = 1) {
  const a = Number.isFinite(Number(comboFactor)) ? Number(comboFactor) : 1;
  const b = Number.isFinite(Number(scaleFactor)) ? Number(scaleFactor) : 1;
  return Math.min(COMBINED_FACTOR_MAX, Math.max(COMBINED_FACTOR_MIN, a * b));
}

/** 空的三档账本 */
export function emptyScaleStats() {
  return {
    small: { total: 0, worse: 0 },
    medium: { total: 0, worse: 0 },
    large: { total: 0, worse: 0 },
  };
}

/**
 * 把一条重放结果记到它那一对、那一档的账上（纯 Map 操作，单测直接踩）。
 *
 * 同一对的多条记录按 ts 取最新的一条当 lastScale；ts 相同按文件顺序后者覆盖
 * （plans.jsonl 是 append-only，靠后的更新）。
 *
 * @param {Map<string, object>} table 汇总表（原地改）
 * @param {object} record plans.jsonl 的一行
 * @param {'better'|'same'|'worse'} changed 重放结论
 * @returns {Map<string, object>}
 */
export function accumulateScale(table, record, changed) {
  const target = table instanceof Map ? table : new Map();
  const key = String(record?.comboKey ?? '').trim();
  if (!key) return target;
  const scale = changeScaleOf(record);
  let entry = target.get(key);
  if (!entry) {
    entry = { byScale: emptyScaleStats(), lastScale: '', lastTs: 0 };
    target.set(key, entry);
  }
  const stat = entry.byScale[scale];
  stat.total += 1;
  if (changed === 'worse') stat.worse += 1;
  const ts = Number(record?.ts) || 0;
  if (ts >= entry.lastTs) {
    entry.lastTs = ts;
    entry.lastScale = scale;
  }
  return target;
}
