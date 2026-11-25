/**
 * 组合路由的历史账：按 comboKey 汇总 plans.jsonl 里每一拍的 outcome。
 *
 * 读的就是 lib/plans-log.js 落盘的同一份 JSONL（每版 stage2 方案一行），不新增 state 字段、
 * 不改 replay、不读配置：调用方把路径传进来，这里只算数。
 *
 * 两处消费：
 *   · grid 的 pickWeightOf：按「成多败少」给这一对乘一个 0.4~1.5 的系数（只影响随机抽取）；
 *   · stage2 提示词：把最近被打回的原因摘要给模型看（最多 3 条、整段 300 字封顶）。
 *
 * 记账口径（与 plans.jsonl 的 outcome 一一对应，见 lib/rewrite.js 的 emit）：
 *   win   decided + judge.action=do
 *   loss  gate_rejected / veto_rejected / exhausted / decided + judge.action=silent
 *   -     abort / empty / rewrite（中间态）以及其余一切：不计
 * 同一拍会写多行（重写的每一版都落一行，callId 相同），按 callId 只取 ts 最大的那一行，
 * 免得一次重写被数成好几败。
 */
import fs from 'node:fs';

/** 系数下限：历史再差也留一点被抽中的机会，别把一对饿死 */
export const COMBO_FACTOR_MIN = 0.4;
/** 系数上限：历史再好也不许长期霸占第一格 */
export const COMBO_FACTOR_MAX = 1.5;
/** 提示词里列几条最近被打回的原因 */
export const COMBO_RECENT_REASONS = 3;
/** 提示词里那一段的字符上限 */
export const COMBO_HISTORY_LINE_MAX = 300;

/**
 * file -> {mtimeMs, size, rows, bad, table}：key 是路径，命中要 mtime+size 都一致。
 * rows 是解析后的记录（readPlanRows 用），table 是按 comboKey 的汇总（loadComboHistory 用），
 * 两者共用同一次读盘，table 懒算。
 */
const cache = new Map();

/** 一条 gate 明细/否决/终审的原文，压成一行短原因（lessons 也按同一口径取原因） */
export function reasonOf(row) {
  const gate = Array.isArray(row?.gate?.items) ? row.gate.items : [];
  if (gate.length > 0) {
    return gate
      .map((one) => {
        const ga = String(one?.ga ?? '').trim() || 'GA?';
        const why = String(one?.why ?? '').trim();
        return why ? `${ga}：${why}` : ga;
      })
      .join('；');
  }
  const hit = row?.veto?.hit;
  if (hit && typeof hit === 'object') {
    const rule = String(hit.rule ?? '').trim();
    const reason = String(hit.reason ?? '').trim();
    if (rule || reason) return [rule, reason].filter(Boolean).join('：');
  }
  const judgeReason = String(row?.judge?.reason ?? '').trim();
  if (judgeReason) return judgeReason;
  return '';
}

/**
 * 一条记录算成 win / loss / null。
 * decided 之外还有 rewrite 这种中间态（每轮重写都落一行），不计数。
 */
export function outcomeOf(row) {
  const outcome = String(row?.outcome ?? '').trim();
  if (outcome === 'gate_rejected' || outcome === 'veto_rejected' || outcome === 'exhausted') return 'loss';
  if (outcome === 'decided') {
    const action = String(row?.judge?.action ?? '').trim().toLowerCase();
    if (action === 'do') return 'win';
    if (action === 'silent') return 'loss';
  }
  return null;
}

/**
 * 逐行解析 + 按 callId 去重（同一拍只留 ts 最大的那行）。
 * 坏行用 try/catch 跳过并计数，不抛：落盘文件被截断、手改坏一行都不该让这一拍没候选。
 *
 * 导出给同目录的 lessons.js / change-scale.js 用：三处读的是同一份 plans.jsonl，
 * 解析口径（尤其 callId 被遮成 `***` 时逐行记）必须只有一份，不然统计会各算各的。
 *
 * @param {string} text
 * @param {{bad?: number}} [options]
 * @returns {{rows: Array<object>, bad: number}}
 */
export function parsePlanLines(text, { bad = 0 } = {}) {
  const rows = new Map();
  let index = 0;
  for (const line of String(text ?? '').split('\n')) {
    const one = line.trim();
    if (!one) continue;
    let row;
    try {
      row = JSON.parse(one);
    } catch {
      bad += 1;
      continue;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      bad += 1;
      continue;
    }
    /*
     * 同一拍会写多行（重写的每一版都落一行），按 callId 只留最后一行。
     * 但 plans.jsonl 落盘前会过 veto 台账的遮罩，callId 这种长串会被遮成 `***`——
     * 现网 283 行全是同一个 `***`，再按它去重就把整份文件压成一行。遮罩值当「没有 id」，
     * 逐行记（同一拍最多一行被计数，中间态 rewrite 本来就不算，见 outcomeOf）。
     */
    const callId = String(row?.callId ?? '').trim();
    const realId = callId && !/^\*+$/.test(callId) ? callId : '';
    const key = realId || `#${index}`;
    index += 1;
    const ts = Number(row?.ts) || 0;
    const prev = rows.get(key);
    if (!prev || ts >= prev.ts) rows.set(key, { row, ts });
  }
  return { rows: [...rows.values()].map((one) => one.row), bad };
}

/** 一串记录 → Map<comboKey, {win, loss, total, reasons}> */
export function summarize(rows = []) {
  const table = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const comboKey = String(row?.comboKey ?? '').trim();
    if (!comboKey) continue;
    const kind = outcomeOf(row);
    if (!kind) continue;
    let entry = table.get(comboKey);
    if (!entry) {
      entry = { win: 0, loss: 0, total: 0, reasons: [] };
      table.set(comboKey, entry);
    }
    entry.total += 1;
    if (kind === 'win') {
      entry.win += 1;
    } else {
      entry.loss += 1;
      const reason = reasonOf(row);
      if (reason) entry.reasons.push(reason);
    }
  }
  return table;
}

/**
 * 读一份 plans.jsonl 的解析结果（带 mtime+size 缓存）。
 *
 * 与 loadComboHistory 共用一次读盘：combo 汇总、lessons 归纳、replay 分层
 * 都从这里取同一份 rows，别再各读一遍（283 行读盘 ~几毫秒，但没理由一天几百拍各读各的）。
 *
 * @param {{file?: string, statFile?: Function, readFile?: Function}} [options]
 * @returns {{file: string, rows: Array<object>, count: number, bad: number, ms: number, cached: boolean}}
 */
export function readPlanRows({ file = '', statFile = fs.statSync, readFile = fs.readFileSync } = {}) {
  const started = Date.now();
  const empty = { file: String(file ?? ''), rows: [], count: 0, bad: 0, ms: 0, cached: false };
  const target = String(file ?? '').trim();
  if (!target) return empty;

  let stat;
  try {
    stat = statFile(target);
  } catch {
    // 还没落过盘（或 stat 不了）：这一拍就是空表。不缓存，下一次 stat 变了自然会重读
    return { ...empty, ms: Date.now() - started };
  }
  const mtimeMs = Number(stat?.mtimeMs) || 0;
  const size = Number(stat?.size) || 0;
  const cached = cache.get(target);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size && Array.isArray(cached.rows)) {
    return { file: target, rows: cached.rows, count: cached.rows.length, bad: cached.bad, ms: Date.now() - started, cached: true };
  }

  let text = '';
  try {
    text = String(readFile(target, 'utf8'));
  } catch {
    // 读不出来按空表处理：下一拍 stat/size 变了会重试，不该把候选拖死
    return { ...empty, ms: Date.now() - started };
  }
  const { rows, bad } = parsePlanLines(text);
  cache.set(target, { mtimeMs, size, rows, bad, table: null });
  return { file: target, rows, count: rows.length, bad, ms: Date.now() - started, cached: false };
}

/**
 * 读一份 plans.jsonl 汇总成历史表。
 *
 * @param {{
 *   file?: string, statFile?: Function, readFile?: Function, log?: Function,
 * }} [options]
 * @returns {{file: string, table: Map<string, {win: number, loss: number, total: number, reasons: string[]}>,
 *   bad: number, rows: number, records: Array<object>, ms: number, cached: boolean}}
 *   records 是解析后的原始记录（lessons / change-scale 用），rows 是条数
 */
export function loadComboHistory({ file = '', statFile = fs.statSync, readFile = fs.readFileSync } = {}) {
  const parsed = readPlanRows({ file, statFile, readFile });
  const entry = parsed.file ? cache.get(parsed.file) : null;
  const table = entry?.table instanceof Map ? entry.table : summarize(parsed.rows);
  // summarize 只跑一次：缓存里存的是同一个 Map，下一拍 mtime/size 没变就直接取
  if (entry && !(entry.table instanceof Map)) entry.table = table;
  return {
    file: parsed.file,
    table,
    bad: parsed.bad,
    rows: parsed.count,
    records: parsed.rows,
    ms: parsed.ms,
    cached: parsed.cached,
  };
}

/**
 * 一对的历史系数：`clamp((win+1)/(loss+1), 0.4, 1.5)`。
 * 没有历史（entry 为空）时返回 1，空表与「不传」在 grid 里行为一致。
 *
 * @param {{win?: number, loss?: number}|null|undefined} entry
 * @returns {number}
 */
export function comboHistoryFactor(entry) {
  if (!entry || typeof entry !== 'object') return 1;
  const win = Math.max(0, Number(entry.win) || 0);
  const loss = Math.max(0, Number(entry.loss) || 0);
  if (win + loss === 0) return 1;
  const raw = (win + 1) / (loss + 1);
  return Math.min(COMBO_FACTOR_MAX, Math.max(COMBO_FACTOR_MIN, raw));
}

/**
 * 提示词里那一段：「这一对历史：成 W 败 L；最近被打回：…」。
 * 没有原因（没败过 / 老记录没写 why）时返回空数组——没历史就一个字不加。
 *
 * @param {{win?: number, loss?: number, reasons?: string[]}|null|undefined} entry
 * @param {number} [max] 整段字符上限，默认 COMBO_HISTORY_LINE_MAX
 * @returns {string[]}
 */
export function renderComboHistoryLines(entry, max = COMBO_HISTORY_LINE_MAX) {
  const reasons = (Array.isArray(entry?.reasons) ? entry.reasons : [])
    .map((one) => String(one ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-COMBO_RECENT_REASONS);
  if (reasons.length === 0) return [];
  const win = Math.max(0, Number(entry?.win) || 0);
  const loss = Math.max(0, Number(entry?.loss) || 0);
  const text = `这一对历史：成 ${win} 败 ${loss}；最近被打回：${reasons.join('；')}`;
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : COMBO_HISTORY_LINE_MAX;
  const chars = [...text];
  return [chars.length > limit ? `${chars.slice(0, Math.max(0, limit - 1)).join('')}…` : text];
}
