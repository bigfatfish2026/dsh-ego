/**
 * 经验折叠（consolidation）：把 plans.jsonl 里已经落盘、但运行时没人读的拒因，
 * 定期折成最多 5 条「规则句」，进 stage2 提示词。
 *
 * 不用模型、纯计数：窗口内（默认 14 天）按「GA 号 + 动作 + why 归类」计数，
 * 否决台账的 rule+reason 单独一路，终审 reason 按归一后的原因片段单独一路；
 * 取被拦最多的几条，套一句能照着自查的模板。一句话最多 90 字，5 条加标题 497 字，
 * 整段上限 520——5 条都完整放下，比把原因原文塞进提示词便宜得多。
 *
 * 为什么要归一：同一关的 why 里常带路径、行号、候选编号（`候选 C01 的默认档是 …`），
 * 不归一的话每条都是独立一条、hits 永远是 1，「最常犯」根本浮不上来。
 * 归一办法：去掉路径/数字/引号，去掉标点，折叠空白，取前 24 个字。
 *
 * 与 combo 摘要的分工（lib/combo-history.js 的 renderComboHistoryLines）：
 *   · combo 讲「这一对」：赢几次输几次、最近被哪几条原因打回；
 *   · lessons 讲「全局」：这一段时间里所有对最常犯的毛病。
 * 两段都进 stage2 提示词，位置是候选表之后、combo 摘要之前；调用方可以用
 * `excludeGa` 把 combo 段已经点名的那几关从 lessons 里剔掉，别把同一句话写两遍。
 *
 * 存储是覆写式的一份 JSON（默认 `~/.dsh-ego/lessons.json`）：
 *   `{version, lastConsolidateAt, lessons: [{id, rule, source, hits, firstSeen, lastSeen}]}`
 * 每条只有任务书要求的六个字段；`lastConsolidateAt` 放在顶层，因为「距上次 consolidate
 * 满 24 小时」这个锚点不属于任何一条规则，也无法从 lastSeen 推出来。
 * 文件读坏 / 缺字段一律回退空表，绝不让 stage2 因为这份缓存坏了不开跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 文件结构版本（以后改字段形状时用） */
export const LESSONS_VERSION = 1;
/** 统计窗口：只看最近 14 天的拒因 */
export const LESSON_WINDOW_DAYS = 14;
/** 最多保留几条规则 */
export const LESSON_MAX = 5;
/** 两次 consolidate 的最小间隔（24 小时） */
export const LESSON_CONSOLIDATE_MS = 24 * 60 * 60 * 1000;
/** 窗口内新增拒因少于这个数就不重算（省得每拍把同一份统计翻来覆去算） */
export const LESSON_MIN_NEW_REJECTIONS = 20;
/** 提示词里那一段的字符上限（含标题与标点） */
export const LESSON_PROMPT_MAX = 520;
/**
 * 一条规则句的字符上限。整段预算按它算：标题 32 字 + 5 条 ×（「· 」2 + 90 + 换行 1）= 497，
 * 留 23 字余量给标题里条数变化（1 位 / 2 位）与标点，所以段上限取 520 时 5 条都完整。
 */
export const LESSON_RULE_MAX = 90;
/**
 * 同一个原语最多占几条规则。
 *
 * 为什么要有：delete 一类能占全部拒因的一半，按 hits 硬取前 5 会被它刷屏
 * （真数据里 5 条全是 delete，第 6 名 edit-file 只差 1 分），别的原语的坑永远进不了提示词。
 * 限 2 条：既留住最常犯的，又给 edit-file / edit-config / draft 各留位置。
 * 认不出原语的那两路（veto / judge）不占配额。
 */
export const LESSON_PER_PRIMITIVE_MAX = 2;
/** 默认落盘路径 */
export const DEFAULT_LESSONS_PATH = path.join(os.homedir(), '.dsh-ego', 'lessons.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTION_LABEL = { reject: '打回', downgrade: '降级' };

/** 按码点截断，超了补一个省略号（别把 emoji / 中文截成半个） */
function clipChars(text, max) {
  const chars = [...String(text ?? '')];
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 0;
  if (limit <= 0 || chars.length <= limit) return chars.join('');
  return `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/** 空白折叠成单个空格 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * why 归一成归类键：去路径、去数字、去引号、去标点，取前 24 个字。
 * 导出给单测踩「同一关不同路径要归到一起」。
 *
 * @param {unknown} why
 * @returns {string}
 */
export function whyKeyOf(why) {
  return oneLine(why)
    .replace(/[\w./~-]*\/[\w./~-]+/g, ' ')
    // 「第 718 行」「第 3 条」这种定位词整体删掉：数字一去掉只剩「第行」，同类原因会被拆成两组
    .replace(/第\s*\d+\s*[行条处段]/g, ' ')
    // 候选编号与 GA 号单独成字段，why 里再出现不参与归类（否则 C01/C02 会把同一句话拆开）
    .replace(/\b(?:C|GA)\d+\b/gi, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[「」『』"'“”‘’`]/g, ' ')
    .replace(/[，。；：、,.;:!?！？（）()【】[\]<>]/g, ' ')
    .replace(/\s+/g, '')
    .slice(0, 24);
}

/** 记录里这一拍的动作原语（单段取读原语；认不出返回空串） */
function primitiveOf(row) {
  const candidate = row?.candidate ?? {};
  const cell = candidate?.action && typeof candidate.action === 'object' ? candidate.action : candidate?.read;
  return oneLine(cell?.primitive);
}

/** 记录时间（毫秒）；认不出给 0 */
function tsOf(row) {
  const ts = Number(row?.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

/** 一条记录的窗口内拒因：gate 的 reject/downgrade 条目，veto 命中，judge 的 reason */
function rejectionsOf(row) {
  const out = [];
  const items = Array.isArray(row?.gate?.items) ? row.gate.items : [];
  for (const item of items) {
    const action = oneLine(item?.action);
    if (action !== 'reject' && action !== 'downgrade') continue;
    const ga = (oneLine(item?.ga) || 'GA?').toUpperCase();
    out.push({ source: 'ga', ga, action, why: oneLine(item?.why), primitive: primitiveOf(row) });
  }
  const hit = row?.veto?.hit;
  if (hit && typeof hit === 'object' && (oneLine(hit.rule) || oneLine(hit.reason))) {
    out.push({ source: 'veto', rule: oneLine(hit.rule), why: oneLine(hit.reason), primitive: primitiveOf(row) });
  }
  const judgeReason = oneLine(row?.judge?.reason);
  if (judgeReason) out.push({ source: 'judge', why: judgeReason, primitive: primitiveOf(row) });
  return out;
}

/** 一条拒因的归类键 */
function keyOf(one) {
  if (one.source === 'ga') return `ga|${one.ga}|${one.action}|${whyKeyOf(one.why)}`;
  if (one.source === 'veto') return `veto|${whyKeyOf(one.rule)}|${whyKeyOf(one.why)}`;
  return `judge|${whyKeyOf(one.why)}`;
}

/**
 * 把一条拒因写成一句能照着自查的规则。
 * 只做模板，不造句：模板里只有 GA 号、动作原语、归一后的原因，测起来可预期。
 */
function ruleOf(group) {
  const why = clipChars(group.why, 48);
  const primitive = group.primitive || '';
  const prefix = primitive ? `${primitive} 这类方案` : '这类方案';
  if (group.source === 'ga') {
    const label = ACTION_LABEL[group.action] ?? '拦下';
    return clipChars(why
      ? `${prefix}先过 ${group.ga}（${label}）：${why}`
      : `${prefix}先过 ${group.ga}（${label}），交之前逐条自查`, LESSON_RULE_MAX);
  }
  if (group.source === 'veto') {
    const rule = clipChars(group.rule || '未命名的否决规则', 24);
    return clipChars(why ? `否决台账常拦「${rule}」：${why}` : `否决台账常拦「${rule}」`, LESSON_RULE_MAX);
  }
  return clipChars(why ? `终审常打回：${why}` : '终审常打回同一类方案', LESSON_RULE_MAX);
}

/**
 * 从规则句里认出原语：`ruleOf` 的固定前缀是「<原语> 这类方案…」。
 * 认不出（veto / judge 两路、老数据里的自由文本）返回空串，这种条目不占原语配额。
 *
 * @param {unknown} rule
 * @returns {string}
 */
export function primitiveOfRule(rule) {
  const found = /^(\S+) 这类方案/.exec(oneLine(rule));
  return found ? found[1] : '';
}

/**
 * 统计窗口内的拒因，归成组。
 *
 * @param {Array<object>} records plans.jsonl 的解析结果
 * @param {{nowMs?: number, windowDays?: number}} [options]
 * @returns {{groups: Map<string, object>, rejections: number}}
 */
export function collectRejections(records, { nowMs = Date.now(), windowDays = LESSON_WINDOW_DAYS } = {}) {
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0 ? Number(windowDays) : LESSON_WINDOW_DAYS;
  const since = Number(nowMs) - days * DAY_MS;
  const groups = new Map();
  let rejections = 0;
  for (const row of Array.isArray(records) ? records : []) {
    const ts = tsOf(row);
    if (ts <= 0 || ts < since) continue;
    for (const one of rejectionsOf(row)) {
      rejections += 1;
      const id = keyOf(one);
      if (!id) continue;
      const prev = groups.get(id);
      if (prev) {
        prev.hits += 1;
        prev.firstSeen = Math.min(prev.firstSeen, ts);
        prev.lastSeen = Math.max(prev.lastSeen, ts);
        if (one.primitive) prev.primitiveVotes.set(one.primitive, (prev.primitiveVotes.get(one.primitive) ?? 0) + 1);
        continue;
      }
      const primitiveVotes = new Map();
      if (one.primitive) primitiveVotes.set(one.primitive, 1);
      groups.set(id, {
        id,
        source: one.source,
        ga: one.ga ?? '',
        action: one.action ?? '',
        rule: one.rule ?? '',
        why: one.why ?? '',
        hits: 1,
        firstSeen: ts,
        lastSeen: ts,
        primitiveVotes,
        primitive: '',
      });
    }
  }
  // 组里出现最多的动作原语进规则句（同一关可能被几种原语撞上，取多数）
  for (const group of groups.values()) {
    let best = '';
    let bestCount = 0;
    for (const [primitive, count] of group.primitiveVotes) {
      if (count > bestCount) {
        best = primitive;
        bestCount = count;
      }
    }
    group.primitive = best;
    group.ruleText = ruleOf(group);
    delete group.primitiveVotes;
  }
  return { groups, rejections };
}

/** 规则按「命中多 → 最近命中」排序；同分时用 id 兜底，保证结果稳定可测 */
export function compareLessons(a, b) {
  return (Number(b?.hits) || 0) - (Number(a?.hits) || 0)
    || (Number(b?.lastSeen) || 0) - (Number(a?.lastSeen) || 0)
    || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

/**
 * 合并旧规则与窗口内的新统计。
 *
 * 命中过的旧规则累加 hits、拉长 lastSeen；窗口内没再命中的旧规则原样留下
 * （陈旧淘汰由 lastSeen 单独判，见下）。最后按 hits 降序取前 max 条。
 *
 * @param {Array<object>} lessons 旧规则
 * @param {Map<string, object>} groups collectRejections 的结果
 * @param {{nowMs?: number, windowDays?: number, max?: number}} [options]
 * @returns {{lessons: Array<object>, added: number, dropped: number}}
 */
export function mergeLessons(lessons, groups, {
  nowMs = Date.now(),
  windowDays = LESSON_WINDOW_DAYS,
  max = LESSON_MAX,
  maxPerPrimitive = LESSON_PER_PRIMITIVE_MAX,
} = {}) {
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0 ? Number(windowDays) : LESSON_WINDOW_DAYS;
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : LESSON_MAX;
  const staleBefore = Number(nowMs) - days * DAY_MS;
  const merged = new Map();
  for (const one of Array.isArray(lessons) ? lessons : []) {
    const id = oneLine(one?.id);
    if (!id) continue;
    merged.set(id, {
      id,
      rule: oneLine(one?.rule),
      source: ['ga', 'veto', 'judge'].includes(one?.source) ? one.source : 'ga',
      hits: Math.max(0, Number(one?.hits) || 0),
      firstSeen: Number(one?.firstSeen) || 0,
      lastSeen: Number(one?.lastSeen) || 0,
    });
  }
  const fresh = new Set();
  for (const [id, group] of groups) {
    const prev = merged.get(id);
    if (prev) {
      prev.hits += group.hits;
      prev.rule = group.ruleText;
      prev.firstSeen = prev.firstSeen > 0 ? Math.min(prev.firstSeen, group.firstSeen) : group.firstSeen;
      prev.lastSeen = Math.max(prev.lastSeen, group.lastSeen);
    } else {
      merged.set(id, {
        id,
        rule: group.ruleText,
        source: group.source,
        hits: group.hits,
        firstSeen: group.firstSeen,
        lastSeen: group.lastSeen,
      });
      fresh.add(id);
    }
  }
  const alive = [...merged.values()].filter((one) => one.rule && one.lastSeen >= staleBefore);
  const dropped = [...merged.values()].length - alive.length;
  alive.sort(compareLessons);
  /*
   * 取前 N 条时按原语设配额：按现有排序扫，该原语已满 maxPerPrimitive 条就跳过、顺延给下一个原语；
   * 认不出原语的（veto / judge 两路）不占配额。扫描到列表末尾就收工——宁可少于 N 条，
   * 也不让一个原语把名额全吃掉。
   */
  const perPrimitiveLimit = Number.isFinite(Number(maxPerPrimitive)) && Number(maxPerPrimitive) > 0
    ? Math.floor(Number(maxPerPrimitive))
    : LESSON_PER_PRIMITIVE_MAX;
  const usedPerPrimitive = new Map();
  const picked = [];
  for (const one of alive) {
    if (picked.length >= limit) break;
    const primitive = primitiveOfRule(one.rule);
    if (primitive) {
      const used = usedPerPrimitive.get(primitive) ?? 0;
      if (used >= perPrimitiveLimit) continue;
      usedPerPrimitive.set(primitive, used + 1);
    }
    picked.push(one);
  }
  // 「新增」= 这次新进表、而且真留下来的规则条数（旧表里已有的重算不算新增）
  return { lessons: picked, added: picked.filter((one) => fresh.has(one.id)).length, dropped };
}

/**
 * 一次完整的 consolidation：统计窗口内拒因 → 合并旧规则 → 淘汰 → 截断。
 *
 * @param {{lessons?: Array<object>, records?: Array<object>, nowMs?: number,
 *   windowDays?: number, max?: number}} [input]
 * @returns {{lessons: Array<object>, added: number, dropped: number, rejections: number}}
 */
export function consolidateLessons({ lessons = [], records = [], nowMs = Date.now(), windowDays = LESSON_WINDOW_DAYS, max = LESSON_MAX } = {}) {
  const { groups, rejections } = collectRejections(records, { nowMs, windowDays });
  const merged = mergeLessons(lessons, groups, { nowMs, windowDays, max });
  return { ...merged, rejections };
}

/** 读缓存文件；文件不在 / 坏 / 字段不对都回退空表（bad 只用于日志，不影响调用方） */
export function readLessons(file = DEFAULT_LESSONS_PATH, { readFile = fs.readFileSync } = {}) {
  const empty = { version: LESSONS_VERSION, lastConsolidateAt: 0, lessons: [], bad: 0 };
  let parsed;
  try {
    parsed = JSON.parse(String(readFile(file, 'utf8')));
  } catch (error) {
    // ENOENT 是「还没跑过」，不算坏；其余解析错误记一行 bad 供日志
    return { ...empty, bad: error?.code === 'ENOENT' ? 0 : 1 };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...empty, bad: 1 };
  const list = Array.isArray(parsed.lessons) ? parsed.lessons : [];
  const lessons = [];
  let bad = 0;
  for (const one of list) {
    const id = oneLine(one?.id);
    const rule = oneLine(one?.rule);
    if (!id || !rule) {
      bad += 1;
      continue;
    }
    lessons.push({
      id,
      rule,
      source: ['ga', 'veto', 'judge'].includes(one?.source) ? one.source : 'ga',
      hits: Math.max(0, Number(one?.hits) || 0),
      firstSeen: Number(one?.firstSeen) || 0,
      lastSeen: Number(one?.lastSeen) || 0,
    });
  }
  return {
    version: Number(parsed.version) || LESSONS_VERSION,
    lastConsolidateAt: Number(parsed.lastConsolidateAt) || 0,
    lessons,
    bad,
  };
}

/** 覆写式落盘：先写 tmp 再 rename，断电最多丢一次 consolidation */
export function writeLessons(file, { lessons = [], lastConsolidateAt = 0 } = {}, {
  writeFile = fs.writeFileSync,
  renameFile = fs.renameSync,
  mkdir = fs.mkdirSync,
} = {}) {
  try {
    mkdir(path.dirname(file), { recursive: true });
    const body = JSON.stringify({
      version: LESSONS_VERSION,
      lastConsolidateAt: Number(lastConsolidateAt) || 0,
      lessons: (Array.isArray(lessons) ? lessons : []).map((one) => ({
        id: one.id,
        rule: one.rule,
        source: one.source,
        hits: one.hits,
        firstSeen: one.firstSeen,
        lastSeen: one.lastSeen,
      })),
    }, null, 2);
    const tmp = `${file}.tmp`;
    writeFile(tmp, body, 'utf8');
    renameFile(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 提示词里那一段：「近期反复被拦的毛病」。0 条返回空数组，一个字不加。
 *
 * @param {Array<object>} lessons
 * @param {{max?: number, excludeGa?: string[]|Set<string>}} [options]
 *   excludeGa：combo 摘要已经点名的那几关（`GA21`），别把同一关写两遍
 * @returns {string[]}
 */
export function renderLessonLines(lessons, { max = LESSON_PROMPT_MAX, excludeGa = [] } = {}) {
  const skip = excludeGa instanceof Set ? excludeGa : new Set((Array.isArray(excludeGa) ? excludeGa : []).map((one) => oneLine(one).toUpperCase()));
  const gaOf = (one) => (one?.source === 'ga' ? (oneLine(one.id).split('|')[1] ?? '').toUpperCase() : '');
  const list = (Array.isArray(lessons) ? lessons : [])
    .map((one) => ({ ...one, rule: oneLine(one?.rule) }))
    .filter((one) => one.rule)
    .filter((one) => !skip.has(gaOf(one)))
    .sort(compareLessons);
  if (list.length === 0) return [];
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : LESSON_PROMPT_MAX;
  const lines = [`近期反复被拦的毛病（全局 ${list.length} 条，按命中排序，写方案前先自查）：`];
  let used = [...lines[0]].length;
  for (const one of list) {
    const line = `· ${one.rule}`;
    const chars = [...line].length;
    // +1 是换行；放不下就截断这一条并收工（整段不许超过 limit）
    if (used + 1 + chars > limit) {
      const room = limit - used - 2; // 换行 + 省略号
      if (room > 1) lines.push(`${clipChars(line, room + 1)}`);
      break;
    }
    lines.push(line);
    used += 1 + chars;
  }
  return lines;
}

/**
 * 每拍开跑时调一次：窗口内新增拒因够 20 条、且距上次 consolidate 满 24 小时才重算。
 *
 * 不满足条件时一次盘都不写，只把当前表还回去——「每拍顺手算」指的是统计很便宜，
 * 不是每拍都落盘。
 *
 * @param {{file?: string, records?: Array<object>, state?: object, nowMs?: number,
 *   windowDays?: number, max?: number, minNew?: number, intervalMs?: number,
 *   readFile?: Function, writeFile?: Function, renameFile?: Function, mkdir?: Function}} [input]
 * @returns {{lessons: Array<object>, added: number, dropped: number, rejections: number,
 *   consolidated: boolean, bad: number, lastConsolidateAt: number}}
 */
export function consolidateIfDue({
  file = DEFAULT_LESSONS_PATH,
  records = [],
  state = null,
  nowMs = Date.now(),
  windowDays = LESSON_WINDOW_DAYS,
  max = LESSON_MAX,
  minNew = LESSON_MIN_NEW_REJECTIONS,
  intervalMs = LESSON_CONSOLIDATE_MS,
  readFile = fs.readFileSync,
  writeFile = fs.writeFileSync,
  renameFile = fs.renameSync,
  mkdir = fs.mkdirSync,
} = {}) {
  const started = Date.now();
  const current = state && Array.isArray(state.lessons)
    ? { lessons: state.lessons, lastConsolidateAt: Number(state.lastConsolidateAt) || 0, bad: Number(state.bad) || 0 }
    : readLessons(file, { readFile });
  const window = collectRejections(records, { nowMs, windowDays });
  const due = Number(nowMs) - (Number(current.lastConsolidateAt) || 0) >= Math.max(0, Number(intervalMs) || 0)
    && window.rejections >= Math.max(0, Number(minNew) || 0);
  if (!due) {
    return {
      lessons: current.lessons,
      added: 0,
      dropped: 0,
      rejections: window.rejections,
      consolidated: false,
      bad: current.bad,
      lastConsolidateAt: current.lastConsolidateAt,
      ms: Date.now() - started,
    };
  }
  const merged = mergeLessons(current.lessons, window.groups, { nowMs, windowDays, max });
  writeLessons(file, { lessons: merged.lessons, lastConsolidateAt: nowMs }, { writeFile, renameFile, mkdir });
  return {
    lessons: merged.lessons,
    added: merged.added,
    dropped: merged.dropped,
    rejections: window.rejections,
    consolidated: true,
    bad: current.bad,
    lastConsolidateAt: nowMs,
    ms: Date.now() - started,
  };
}
