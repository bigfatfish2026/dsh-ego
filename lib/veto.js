/**
 * 否决台账（裁决器·第二道关）。
 *
 * 台账是「用户已经表过态」的只读事实库：提议器一个字都不看，所有判断都在裁决侧。
 * 文件一行一条 JSONL，append-only；读坏了、缺行、文件不在都当空账，绝不抛。
 *
 * 本文件只 import `grid.js` 的格对归一函数，不 import `index.js`，避免环。
 * 三条判据（规则第七节）：
 *   V1 combo + 对象：格对相同、objectNames 有交集、60 天内被否 ≥1 次 → 拒
 *   V2 action：同 objectKind + actionPrimitive，60 天内被否 ≥2 次（按票去重）→ 拒
 *   V3 升级：同 objectKind + actionPrimitive，60 天内被否 3 次 → 拒 + 报用户
 * 单段读（actionPrimitive 为空）只走 V1，不进 V2/V3。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeComboKey } from './grid.js';

/** 否决窗口：60 天，写死，不做成配置项。 */
export const VETO_WINDOW_DAYS = 60;
/** 给 judge 的「最近被否方向」条数（规则第八节）。 */
export const VETO_RECENT_LIMIT = 5;
/** 否决语上限（规则第四节：≤200 字）。 */
export const VETO_REASON_MAX = 200;
/** 票面 brief 上限（规则第四节：≤34 列）。 */
export const VETO_BRIEF_MAX = 34;
/** verdict 只认这两种；其余（done 等）当没写，不参与判定。 */
export const VETO_VERDICTS = Object.freeze(['dropped', 'wontfix']);

const WINDOW_MS_PER_DAY = 86400_000;
const HOME_DIR = os.homedir();
const PATH_ROOT = process.env.DSH_EGO_ROOT || path.posix.join(HOME_DIR, 'fatfish');
const HOME_PREFIX = `${HOME_DIR}/`;

/**
 * 对象名归一（读侧写入侧共用一份，规则第四节）：
 *   · `~` 展开成家目录；
 *   · 路径折叠 `//` / `.` / `..`、去尾斜杠，相对路径按工作区根补全；
 *   · 去掉家目录前缀，`<root>/docs/x.md` 与 `docs/x.md` 都落成同一个键；
 *   · URL、unit 名、记忆 id、票号这些非路径原样，不折叠大小写（Linux 路径区分大小写）。
 *
 * @param {unknown} raw
 * @returns {string} 归一后的键；认不出返回空串
 */
export function normalizeObjectName(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (value.startsWith('~')) {
    value = path.posix.join(os.homedir(), value.slice(1).replace(/^\/+/, ''));
  }
  const looksPath = value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.includes('/');
  if (!looksPath) return value;
  let normalized = path.posix.normalize(value);
  if (!normalized.startsWith('/')) normalized = path.posix.join(PATH_ROOT, normalized);
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized === HOME_DIR) return '';
  if (normalized.startsWith(HOME_PREFIX)) normalized = normalized.slice(HOME_PREFIX.length);
  return normalized;
}

/** 写前脱敏（规则第六节）：台账会进 judge 提示词，token / 长串一律换成 `***`。 */
const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
  /\bcrsr_[A-Za-z0-9_-]{8,}\b/g,
  /\boc_[A-Za-z0-9_-]{8,}\b/g,
];

/**
 * 抹掉 token / key / 密码：已知前缀整段换 `***`；其余长度 ≥20、不含 `/` 和空格的
 * 连续 ASCII 串也换 `***`。中文否决语不动——规则要留人话，别把整句吃掉。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactVetoText(text) {
  let value = String(text ?? '');
  for (const pattern of TOKEN_PATTERNS) value = value.replace(pattern, '***');
  value = value.replace(/[A-Za-z0-9_+\-]{20,}/g, '***');
  return value;
}

/** 按码点截断（brief / reason 的上限是「字」不是字节）。 */
export function clipChars(text, max) {
  const chars = [...String(text ?? '')];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/** `11-10`：否决语里给用户看的月日（本地时间）。 */
export function formatMonthDay(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '（没记日期）';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 一行台账 → 内部条目。认不出的返回 null（规则第七节空账保护）。
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const comboKey = normalizeComboKey(raw.comboKey);
  if (!comboKey) return null;
  if (!Array.isArray(raw.objectNames)) return null;
  const objectNames = [...new Set(raw.objectNames.map(normalizeObjectName).filter(Boolean))].sort();
  if (objectNames.length === 0) return null;
  const verdict = String(raw.verdict ?? '').trim();
  if (!VETO_VERDICTS.includes(verdict)) return null;
  return {
    ts,
    ticketId: String(raw.ticketId ?? '').trim(),
    comboKey,
    objectNames,
    readPrimitive: String(raw.readPrimitive ?? '').trim(),
    objectKind: String(raw.objectKind ?? '').trim(),
    actionPrimitive: String(raw.actionPrimitive ?? '').trim(),
    brief: String(raw.brief ?? '').trim(),
    reason: String(raw.reason ?? '').trim(),
    verdict,
  };
}

/**
 * 读台账。文件不在 / 读不了 / 坏行一律降级：坏行记进 `skipped`，其余照常。
 * 不做窗口过滤——窗口在 `checkVeto` / `selectRecentVeto` 里按传入的 `now` 算，
 * 这样按 mtime 缓存也不会把「今天还没过期」的行永远滤掉。
 *
 * @param {string} file
 * @param {{now?: number, readFile?: Function}} [options]
 * @returns {{path: string, entries: object[], byCombo: Map<string, object[]>,
 *   byAction: Map<string, object[]>, skipped: number, mtimeMs: number|null, exists: boolean}}
 */
export function loadVeto(file, { now = Date.now(), readFile = fs.readFileSync } = {}) {
  void now;
  const ledger = {
    path: String(file ?? ''),
    entries: [],
    byCombo: new Map(),
    byAction: new Map(),
    skipped: 0,
    mtimeMs: null,
    exists: false,
    // 读失败的原始信息：只给日志打点用，判定链一个字都不看（checkVeto 只读 entries）
    readError: '',
    readErrorCode: '',
  };
  let text = '';
  try {
    const stat = fs.statSync(file);
    ledger.mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
    ledger.exists = true;
    text = readFile(file, 'utf8');
  } catch (error) {
    // 文件不在 / 没权限：当空账，不抛；错误只留给打点（读没读、为什么没读）
    ledger.readError = clipChars(String(error?.message ?? error ?? ''), 120);
    ledger.readErrorCode = String(error?.code ?? '').trim();
    return ledger;
  }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ledger.skipped += 1;
      continue;
    }
    const entry = normalizeEntry(parsed);
    if (!entry) {
      ledger.skipped += 1;
      continue;
    }
    ledger.entries.push(entry);
    if (!ledger.byCombo.has(entry.comboKey)) ledger.byCombo.set(entry.comboKey, []);
    ledger.byCombo.get(entry.comboKey).push(entry);
    if (entry.actionPrimitive) {
      const key = `${entry.objectKind}|${entry.actionPrimitive}`;
      if (!ledger.byAction.has(key)) ledger.byAction.set(key, []);
      ledger.byAction.get(key).push(entry);
    }
  }
  return ledger;
}

/**
 * 台账加载的一行日志：让「账本到底读没读、读了几条」看得见。
 *   · 正常：`veto_load:3 条｜跳过 1 行｜249 字节｜/path`（坏行 0 时不写「跳过」那截）
 *   · 不存在：`veto_load:文件不存在｜/path`
 *   · 空账本：`veto_load:0 条｜空账本｜/path`
 *   · 读失败：`veto_load:读失败｜/path｜<错误一句话>`
 *
 * 只负责拼字符串，不碰状态、不抛；去重交给 `createVetoLoadReporter`。
 *
 * @param {ReturnType<typeof loadVeto>} ledger
 * @param {{bytes?: number|null}} [options] stat 到的字节数（拿不到传 null）
 * @returns {string}
 */
export function formatVetoLoadLine(ledger, { bytes = null } = {}) {
  const file = String(ledger?.path ?? '');
  const error = String(ledger?.readError ?? '').trim();
  if (error) {
    if (String(ledger?.readErrorCode ?? '').trim() === 'ENOENT') return `veto_load:文件不存在｜${file}`;
    return `veto_load:读失败｜${file}｜${error}`;
  }
  if (!ledger?.exists) return `veto_load:文件不存在｜${file}`;
  const count = Array.isArray(ledger.entries) ? ledger.entries.length : 0;
  const skipped = Math.max(0, Number(ledger.skipped) || 0);
  const size = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : null;
  if (size === 0) return `veto_load:0 条｜空账本｜${file}`;
  const skipPart = skipped > 0 ? `｜跳过 ${skipped} 行` : '';
  const sizePart = size === null ? '' : `｜${size} 字节`;
  return `veto_load:${count} 条${skipPart}${sizePart}｜${file}`;
}

/**
 * 加载打点去重器：同一个「状态」只打一次。
 * 状态 = 正常文件按 mtime + 字节数算（mtime 或大小一变就重打）；不存在 / 读失败按各自的
 * 状态键算（不拿路径拼进键——一个 reporter 只服务一个 vetoPath）。
 *
 * 整段 try/catch：打点自己坏了（拼串、日志写入）静默跳过，绝不影响 checkVeto 那一拍。
 *
 * @param {{log?: (line: string) => void, format?: typeof formatVetoLoadLine}} [options]
 * @returns {(ledger: ReturnType<typeof loadVeto>, options?: {bytes?: number|null}) => string}
 */
export function createVetoLoadReporter({ log, format = formatVetoLoadLine } = {}) {
  let lastKey = '';
  return function reportVetoLoad(ledger, { bytes = null } = {}) {
    try {
      const error = String(ledger?.readError ?? '').trim();
      let key;
      if (error) key = `readError:${String(ledger?.readErrorCode ?? '').trim()}:${error}`;
      else if (!ledger?.exists) key = 'missing';
      else key = `ok:${Number(ledger?.mtimeMs) || 0}:${Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 'x'}`;
      if (key === lastKey) return '';
      lastKey = key;
      const line = String(format(ledger, { bytes }) ?? '');
      if (!line) return '';
      if (typeof log === 'function') log(line);
      return line;
    } catch {
      return '';
    }
  };
}

/** 同票多行只算一次（规则第七节 V1/V2/V3 都是「按 ticketId 去重」）；同票取最新那行。 */
function latestByTicket(entries) {
  const latest = new Map();
  for (const entry of entries) {
    const key = entry.ticketId || `ts:${entry.ts}`;
    const prev = latest.get(key);
    if (!prev || entry.ts > prev.ts) latest.set(key, entry);
  }
  return [...latest.values()];
}

/** 窗口内的行：`now - ts <= windowDays 天`。未来时间也按窗口内算（保守少拒不算多拒）。 */
function entriesInWindow(entries, now, windowDays) {
  const windowMs = Math.max(0, Number(windowDays) || VETO_WINDOW_DAYS) * WINDOW_MS_PER_DAY;
  return (Array.isArray(entries) ? entries : []).filter(
    (entry) => Number.isFinite(entry?.ts) && now - entry.ts <= windowMs,
  );
}

/**
 * 判这一版方案有没有撞上被否过的方向。
 *
 * @param {{comboKey?: unknown, objectNames?: unknown[], objectKind?: unknown,
 *   actionPrimitive?: unknown, readPrimitive?: unknown, brief?: unknown}} plan
 * @param {ReturnType<typeof loadVeto>} ledger
 * @param {{now?: number, windowDays?: number}} [options]
 * @returns {{ok: true, reason: '', hit: null}
 *   | {ok: false, reason: string, hit: {rule: 'combo'|'action'|'escalate', ts: number,
 *       ticketId: string, count: number, comboKey: string, objectName: string}}}
 */
export function checkVeto(plan, ledger, { now = Date.now(), windowDays = VETO_WINDOW_DAYS } = {}) {
  const entries = entriesInWindow(ledger?.entries, now, windowDays);
  const targetCombo = normalizeComboKey(plan?.comboKey);
  const targetNames = new Set(
    (Array.isArray(plan?.objectNames) ? plan.objectNames : []).map(normalizeObjectName).filter(Boolean),
  );
  const objectKind = String(plan?.objectKind ?? '').trim();
  const actionPrimitive = String(plan?.actionPrimitive ?? '').trim();

  // V1：格对相同 + 对象名有交集（对象名不拼进 comboKey）
  if (targetCombo) {
    const hits = latestByTicket(
      entries.filter(
        (entry) => entry.comboKey === targetCombo && entry.objectNames.some((name) => targetNames.has(name)),
      ),
    );
    if (hits.length > 0) {
      const latest = hits.slice().sort((a, b) => b.ts - a.ts)[0];
      const objectName = latest.objectNames.find((name) => targetNames.has(name)) || latest.objectNames[0] || '';
      return {
        ok: false,
        reason: `用户 ${formatMonthDay(latest.ts)} 否过这个方向：${clipChars(latest.reason, 60) || '（没写原因）'}`,
        hit: {
          rule: 'combo',
          ts: latest.ts,
          ticketId: latest.ticketId,
          count: hits.length,
          comboKey: latest.comboKey,
          objectName,
        },
      };
    }
  }

  // 单段读没有动作原语可归组，只走 V1
  if (actionPrimitive) {
    const hits = latestByTicket(
      entries.filter(
        (entry) => entry.objectKind === objectKind && entry.actionPrimitive === actionPrimitive,
      ),
    );
    if (hits.length >= 3) {
      const latest = hits.slice().sort((a, b) => b.ts - a.ts)[0];
      return {
        ok: false,
        reason:
          `这个方向 60 天内被否了 ${hits.length} 次，可能不是点子错，是素材或 gate 缺东西`
          + `（最近 ${formatMonthDay(latest.ts)}：${clipChars(latest.reason, 60) || '（没写原因）'}）`,
        hit: {
          rule: 'escalate',
          ts: latest.ts,
          ticketId: latest.ticketId,
          count: hits.length,
          comboKey: latest.comboKey,
          objectName: latest.objectNames[0] || '',
        },
      };
    }
    if (hits.length >= 2) {
      const latest = hits.slice().sort((a, b) => b.ts - a.ts)[0];
      return {
        ok: false,
        reason:
          `${objectKind} + ${actionPrimitive} 这个方向 60 天内被否了 ${hits.length} 次`
          + `（最近 ${formatMonthDay(latest.ts)}：${clipChars(latest.reason, 60) || '（没写原因）'}）`,
        hit: {
          rule: 'action',
          ts: latest.ts,
          ticketId: latest.ticketId,
          count: hits.length,
          comboKey: latest.comboKey,
          objectName: latest.objectNames[0] || '',
        },
      };
    }
  }

  return { ok: true, reason: '', hit: null };
}

/**
 * 给 judge 的「最近 5 条被用户否掉的方向」（规则第八节）：60 天内、按票去重、
 * 按 ts 倒序、最多 limit 条；空台账返回 []，让提示词整段不出现。
 *
 * @param {ReturnType<typeof loadVeto>} ledger
 * @param {{now?: number, limit?: number, windowDays?: number}} [options]
 * @returns {object[]}
 */
export function selectRecentVeto(ledger, { now = Date.now(), limit = VETO_RECENT_LIMIT, windowDays = VETO_WINDOW_DAYS } = {}) {
  const bounded = Math.max(0, Number(limit) || 0);
  return latestByTicket(entriesInWindow(ledger?.entries, now, windowDays))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, bounded);
}

/** 写入侧只收绝对路径或非路径标识符；相对路径一律拒（规则第四节）。 */
function isRelativePath(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (value.startsWith('./') || value.startsWith('../')) return true;
  return value.includes('/');
}

/**
 * 追加一行台账（写入侧，人工 / 主会话用）。ego 的裁决器自己**不调用**它——规则第六节
 * 写死写入侧人工；这里只把归一路径、脱敏、字段上限收成一个函数，免得手写 JSON 写歪。
 *
 * append-only：单行一次 write，不读旧行、不改旧行、不重排；同一张票重复写由读侧按
 * ticketId 去重。不用 tmp+rename（rename 会覆盖别的手工追加）。
 *
 * @param {object} plan
 * @param {string} plan.ticketId 被丢的票号
 * @param {string} plan.comboKey 格对：`inspect|config→edit-config|config`
 * @param {string[]} plan.objectNames 绝对路径 / 标识符，≥1 条
 * @param {'dropped'|'wontfix'} [plan.verdict='dropped']
 * @param {string} [plan.reason] 人的否决语（会被脱敏、截 200 字）
 * @param {string} [plan.brief] 票面一句话（会被脱敏、截 34 字）
 * @param {string} [plan.objectKind] 动作格对象类
 * @param {string} [plan.actionPrimitive] 动作格原语；单段读留空
 * @param {string} [plan.readPrimitive] 读格原语
 * @param {number} [plan.ts] 否决时刻；缺省 now
 * @param {{file: string, now?: number, appendFile?: Function, homeDir?: string}} options
 * @returns {{ok: true, entry: object} | {ok: false, reason: string}}
 */
export function recordVeto(plan = {}, { file, now = Date.now(), appendFile = fs.appendFileSync, homeDir = os.homedir() } = {}) {
  if (!file) return { ok: false, reason: '没有 vetoPath' };
  const comboKey = normalizeComboKey(plan.comboKey);
  if (!comboKey) return { ok: false, reason: 'comboKey 认不出（要格对，如 inspect|config→edit-config|config）' };
  const objectKind = String(plan.objectKind ?? '').trim();
  const objectNames = [];
  for (const raw of Array.isArray(plan.objectNames) ? plan.objectNames : []) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    if (isRelativePath(value)) {
      return { ok: false, reason: `objectNames 写入侧只收绝对路径（基准 ${PATH_ROOT}）：${value}` };
    }
    if (objectKind === 'config' && !(value.startsWith('/') || value.startsWith('~'))) {
      return { ok: false, reason: `config 类的 object.value 必须是绝对路径：${value}` };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || !value.includes('/')) {
      if (!objectNames.includes(value)) objectNames.push(value);
      continue;
    }
    const expanded = value.startsWith('~')
      ? path.posix.join(homeDir, value.slice(1).replace(/^\/+/, ''))
      : value;
    if (!objectNames.includes(expanded)) objectNames.push(expanded);
  }
  objectNames.sort();
  if (objectNames.length === 0) return { ok: false, reason: 'objectNames 为空' };
  const verdict = String(plan.verdict ?? 'dropped').trim() || 'dropped';
  if (!VETO_VERDICTS.includes(verdict)) {
    return { ok: false, reason: `verdict 只能是 dropped / wontfix：${verdict}` };
  }
  const ts = Number(plan.ts);
  const entry = {
    ts: Number.isFinite(ts) && ts > 0 ? ts : now,
    ticketId: String(plan.ticketId ?? '').trim(),
    comboKey,
    objectNames,
    readPrimitive: String(plan.readPrimitive ?? '').trim(),
    objectKind,
    actionPrimitive: String(plan.actionPrimitive ?? '').trim(),
    brief: clipChars(redactVetoText(plan.brief), VETO_BRIEF_MAX),
    reason: clipChars(redactVetoText(plan.reason), VETO_REASON_MAX),
    verdict,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    return { ok: false, reason: `写台账失败：${String(error?.message ?? error)}` };
  }
  return { ok: true, entry };
}
