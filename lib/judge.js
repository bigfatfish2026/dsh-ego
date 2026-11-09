/**
 * 裁决器：独立上下文的第二段 agent，只看「点子原文 + 为什么」，不给提议器的过程。
 * 三选一：silent（什么都不做，用户看不见）/ ask（跟用户说一句）/ do（直接开票）。
 *
 * 裁决原则写在提示词里，这里也做一层硬校验：动作非法、ask 没话、do 没目标都算失败。
 */
import { extractJson } from './agent-run.js';

/** dispatch_open 的 brief 上限（列宽）：一个汉字算 2 列 */
export const BRIEF_MAX_COLUMNS = 34;

export const ACTIONS = ['silent', 'ask', 'do'];

/**
 * ask 那一支说给用户听的话的硬规矩（写进提示词，解析时也照这个查）。
 * 用户看不懂「死账」「下刀」这种黑话，也不知道 55 条在哪张表、为什么现在动，
 * 所以对象、数量、依据、一个明确问句，缺一不可。
 *
 * 字数口径：**字符数（码点，含标点、路径、数字）**，不是汉字数。
 * 为什么不是汉字数：ask 文案必须写清对象，路径、表名、时间和数字都占字符但不占汉字；
 * 给模型讲「汉字数」它数不准，讲字符数它也数不准，但代码只能这么查。
 * 所以上限放到 160（够装一条路径 + 两个数字 + 80 来个汉字），下限 60 保住三要素，
 * 提示词里写清「字符」并给汉字参考（约 50~90 个汉字）。
 * 两个数都能改：配置项 `judge.askMinChars` / `judge.askMaxChars`。
 */
export const ASK_MIN_CHARS = 60;
export const ASK_MAX_CHARS = 160;

/** 提示词和报错共用的口径说明，只在这一个地方写 */
export function askLenNote(minChars = ASK_MIN_CHARS, maxChars = ASK_MAX_CHARS) {
  return `${minChars}~${maxChars} 个字符（汉字、标点、字母、数字各算 1 个，大约 50~90 个汉字）`;
}

/** 默认口径（不传自定义规则时用） */
export const ASK_LEN_NOTE = askLenNote();

/** 黑话和内部术语默认值：命中就不许发出去。可换：配置项 `judge.forbiddenWords`。 */
export const ASK_FORBIDDEN = [
  '死账',
  '下刀',
  '捞不回来',
  '开刀',
  '动刀',
  '按照规则',
  '按规则',
  '规则 2',
  '规则2',
  '您',
];

/** 对象类名词默认值：表名/路径之外的兜底判断 */
export const ASK_OBJECT_HINTS = [
  '表',
  '文件',
  '目录',
  '路径',
  '服务',
  '日志',
  '备份',
  '记录',
  '队列',
  '仓库',
  '缓存',
  '条目',
  '会话',
  '进程',
  '端口',
];

/** 字面字数（汉字、英文、标点都算 1）——就是 ask 口径里的「字符」 */
export function charLength(text) {
  return [...String(text ?? '')].length;
}

/** 文案里出现的数字（阿拉伯数字，含小数） */
export function numbersIn(text) {
  return String(text ?? '').match(/\d+(?:\.\d+)?/g) ?? [];
}

/**
 * 查 ask 文案够不够格发到用户那边。
 * @param {string} text
 * @param {{idea?: string, why?: string, rules?: {minChars?: number, maxChars?: number, forbidden?: string[]}}} [evidence]
 *   点子与理由：文案里的数字必须来自这里；rules 覆盖默认长度与禁词（配置项 `judge.*`）
 * @returns {{ok: boolean, problems: string[], len: number}}
 */
export function validateAskText(text, { idea = '', why = '', rules = {} } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, problems: ['ask 文案是空的'], len: 0 };

  const minChars = Number(rules?.minChars) > 0 ? Number(rules.minChars) : ASK_MIN_CHARS;
  const maxChars = Number(rules?.maxChars) > 0 ? Number(rules.maxChars) : ASK_MAX_CHARS;
  const forbidden = Array.isArray(rules?.forbidden) && rules.forbidden.length > 0 ? rules.forbidden.map(String) : ASK_FORBIDDEN;

  const problems = [];
  const len = charLength(raw);
  if (len < minChars) {
    problems.push(`只有 ${len} 个字符，不到 ${minChars} 个字符（约 50 个汉字），对象/数量/依据说不全`);
  }
  if (len > maxChars) {
    problems.push(`有 ${len} 个字符，超过 ${maxChars} 个字符，一条消息读不完`);
  }

  for (const word of forbidden) {
    if (raw.includes(word)) problems.push(`用了禁词或内部术语「${word}」`);
  }

  const questions = (raw.match(/[？?]/g) ?? []).length;
  if (questions === 0) problems.push('没有明确问句，用户不知道该定什么');
  if (questions > 1) problems.push(`有 ${questions} 个问句，只能留一个`);

  const nums = numbersIn(raw);
  if (nums.length === 0) problems.push('没写数量，用户不知道要动多少');

  const known = new Set([...numbersIn(idea), ...numbersIn(why)]);
  if (known.size > 0) {
    const extra = nums.filter((n) => !known.has(n));
    if (extra.length > 0) problems.push(`自己加了点子/理由里没有的数字：${extra.join('、')}`);
  }

  const hasIdentifier = /[A-Za-z][A-Za-z0-9_.\-/]{2,}/.test(raw);
  const hasObjectNoun = ASK_OBJECT_HINTS.some((word) => raw.includes(word));
  if (!hasIdentifier && !hasObjectNoun) {
    problems.push('没写清对象（表名 / 路径 / 服务 / 文件）');
  }

  return { ok: problems.length === 0, problems, len };
}

const pad = (n) => String(n).padStart(2, '0');
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f9ff}]/u;

/** 这个字符串占多少列（汉字/全角/emoji 算 2） */
export function columns(text) {
  let n = 0;
  for (const ch of String(text ?? '')) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/** 按列宽截断：dispatch_open 的 brief 超了会直接拒绝 */
export function truncateColumns(text, max = BRIEF_MAX_COLUMNS) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : BRIEF_MAX_COLUMNS;
  let out = '';
  let width = 0;
  for (const ch of String(text ?? '')) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (width + w > limit) break;
    out += ch;
    width += w;
  }
  return out;
}

/** 「11-08 14:50」 */
export function formatTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '（没记过）';
  const d = new Date(n);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「3 小时 20 分钟前」这种给模型看的人话 */
export function formatGap(ts, now = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '（没记过）';
  const minutes = Math.max(0, Math.round((now - n) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟前`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时前`;
}

/** 裁决器提示词：只喂点子原文和 why，外加 state 里两个时间点 */
export function buildJudgePrompt({
  idea,
  why,
  now = new Date(),
  state = {},
  lastReportAt = state?.lastReportAt,
  lastAskAt = state?.lastAskAt,
  rules = {},
} = {}) {
  const minChars = Number(rules?.minChars) > 0 ? Number(rules.minChars) : ASK_MIN_CHARS;
  const maxChars = Number(rules?.maxChars) > 0 ? Number(rules.maxChars) : ASK_MAX_CHARS;
  const forbidden = Array.isArray(rules?.forbidden) && rules.forbidden.length > 0 ? rules.forbidden.map(String) : ASK_FORBIDDEN;
  const lenNote = askLenNote(minChars, maxChars);
  const isoNow = now.toISOString();
  // 时间戳为空就整段写「（没记过）」，别再套一层括号
  const stamp = (ts) => {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '（没记过）';
    return `${formatTime(n)}（${formatGap(n, now.getTime())}）`;
  };
  return [
    '（这是你自己开的一轮：下面这段不是谁发来的消息，是上一段「提议器」交给你的一句点子和它的理由。）',
    '',
    '你是一个运行在 agent 宿主里的助手。这一轮只做裁决：这件事，做还是不做？',
    '你看不到提议器的过程，也不许自己动手——回复里只有判断。',
    '',
    `点子：${String(idea ?? '').trim() || '（空）'}`,
    `理由：${String(why ?? '').trim() || '（空）'}`,
    '',
    `现在是 ${isoNow}。`,
    `上次让用户知道点事：${stamp(lastReportAt)}。`,
    `上次问用户：${stamp(lastAskAt)}。`,
    '',
    '三个选项，只能选一个：',
    '· silent —— 什么都不做。用户什么都看不见，这是默认答案。',
    '· ask —— 跟用户说一句话，把决定权交给她。text 就是你打算说的那句话。',
    '· do —— 直接开票让小事自己做完。ticket.goal 写要干什么，ticket.brief 写一句票面（不超过 17 个汉字）。',
    '',
    'ask 的 text 必须让用户一眼看懂，三样缺一不可：',
    'a. 对象：具体是什么（表名 / 路径 / 服务 / 文件）加数量，例：「example-db 的 jobs 表里 55 条 retry 记录」。',
    'b. 为什么：一句话讲清为什么值得动，带数字或依据，例：「原文已不存在，重放只会再标一次 done，却占着每轮的重放名额，现在队列共 337 条」。',
    'c. 要用户定什么：一个明确问句，例：「清掉这 55 条吗？清掉不可恢复；不清就继续占名额」。',
    '',
    'ask 文案的硬规矩：',
    `· 不许用这些词或内部术语：${forbidden.join('、')}；不许说「按照规则 2」这种内部术语；不许只说「有风险」却不给具体后果。`,
    `· 长度按字符数算：${lenNote}，一条消息读完；不要列表、不要 markdown。`,
    '· 路径、表名、数字都算字符，别为了压字数把对象写模糊——宁可少写一句形容词。',
    '· 只留一个问句，而且必须是**最后一句**：问句后面不许再补解释、不许再补第二问。',
    '· 正常说话，别客套；别写「是否需要进行处理」这种公文体。',
    '· 数字只能来自上面「点子」和「理由」里出现过的事实，不许自己编。',
    '',
    '正例（就是这次这件事，写成用户能直接点头的样子）：',
    '「example-db 的 jobs 表里有 55 条 retry 记录，它们引用的原文早就没了，重放只会再标一次 done，却每轮占一个名额——当前队列 337 条。清掉这批吗？清掉不可恢复，不清就继续占名额。」',
    '反例（用户看不懂，别学）：「嗯，55 条死账删了捞不回来，assistant 不敢自己下刀，用户点头 assistant 再动。」',
    '反例缺了什么：没说什么表、什么记录、为什么现在动、删了会怎样。',
    '',
    'JSON 必须一次写完整、闭合：以 { 开头、以 } 结尾，每个字段都写全，宁可短一点也别写到一半停。',
    '反例（写到一半断掉，解析不出来，整拍作废，用户那一拍什么都看不到）：',
    '{"action": "ask", "text": "data/tmp/export_draft 里有 144 个中间产物，清掉吗？只删',
    '断在哪：text 的引号没闭、ticket 和 reason 没写、最后的 } 没有。这样交上来等于白写一轮。',
    '',
    '裁决原则（按顺序看）：',
    '1. 动作小到不需要重启、或者能撤回（改代码能从 git 捞回来、跑坏了能重跑、只是查一查）→ do。',
    '2. 删日志、清备份、清缓存、删文件这类删了不可恢复的 → 只能 ask，绝不许 do。',
    '3. 汇报类（账号用量、整理结果、机器状态）先看上面「上次让用户知道点事」：',
    '   不到 1 天就 silent，超过 1 天才考虑 ask 或 do。一天最多打扰用户一次。',
    '4. 拿不准就 ask，不要硬做。',
    '5. 纯闲聊、没实际内容、点子太泛落地不了 → silent。',
    '6. 用户这会儿不需要知道的事，别为了刷存在感说。',
    '',
    '只输出一个 JSON 对象，别加解释：',
    '{"action": "silent|ask|do", "text": "action=ask 时说给用户的那句话（按上面 ask 的规矩），别的时候留空串",',
    ' "ticket": {"goal": "要干什么", "brief": "票面一句话"}, "reason": "一句理由"}',
  ].join('\n');
}

/**
 * 解析裁决器的回复，并带回「为什么没过」。
 *
 * 校验吃的永远是 runAgent 给的完整文本（`assistantText` 不裁剪，`extractJson` 全文扫），
 * 曾经有一拍回复完整闭合，被拦是因为 ask 文案超了当时的上限——日志里看着断在 160 字
 * 只是显示时截的。所以这个函数必须分开报：
 *   · JSON 没闭合 → 模型输出真被截断（finish=max-tokens 或写到一半停了）；
 *   · JSON 闭合但 ask 文案不合格 → 校验拦的，问题在文案不在截断。
 *
 * @param {string} text
 * @param {{idea?: string, why?: string}} [evidence] 传入后，ask 文案里的数字必须来自点子和理由
 * @returns {{ok: boolean, decision: {action: 'silent'|'ask'|'do', text: string, ticket: {goal: string, brief: string}|null, reason: string}|null, problems: string[], len: number, text: string, scope?: 'reply'|'ask'}}
 *          scope='ask' 时 len/text 说的是 ask 文案本身（不是整段 JSON）
 */
export function parseDecisionReport(text, evidence = {}) {
  const raw = String(text ?? '');
  const len = charLength(raw);
  const fail = (...problems) => ({ ok: false, decision: null, problems, len, text: raw, scope: 'reply' });

  const value = extractJson(raw);
  if (!value) {
    // 分两种：有 { 但没配平 = 写到一半断了；连 { 都没有 = 模型压根没按格式答
    if (raw.includes('{')) return fail('回复里的 JSON 没闭合（写到一半被截断，或后面的字把 } 吞了）');
    return fail('回复里没有 JSON 对象');
  }
  const action = typeof value.action === 'string' ? value.action.trim().toLowerCase() : '';
  if (!ACTIONS.includes(action)) {
    return fail(`action 非法：${JSON.stringify(value.action ?? null)}（只能 silent / ask / do）`);
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (action === 'silent') return { ok: true, decision: { action, text: '', ticket: null, reason }, problems: [], len, text: raw };
  if (action === 'ask') {
    const said = typeof value.text === 'string' ? value.text.trim() : '';
    if (!said) return fail('action=ask 但 text 是空的');
    // 文案不合格就整拍失败：宁可这一拍不说，也不把用户看不懂的话发出去
    const checked = validateAskText(said, evidence);
    if (!checked.ok) {
      return { ok: false, decision: null, problems: checked.problems, len: checked.len, text: said, scope: 'ask' };
    }
    return { ok: true, decision: { action, text: said, ticket: null, reason }, problems: [], len, text: raw };
  }
  const goal = typeof value.ticket?.goal === 'string' ? value.ticket.goal.trim() : '';
  if (!goal) return fail('action=do 但 ticket.goal 是空的');
  const briefRaw = typeof value.ticket?.brief === 'string' ? value.ticket.brief.trim() : '';
  // brief 空就拿 goal 兜底：dispatch_open 要求非空，而列宽只有 34
  const brief = truncateColumns(briefRaw || goal, BRIEF_MAX_COLUMNS);
  return { ok: true, decision: { action, text: '', ticket: { goal, brief }, reason }, problems: [], len, text: raw };
}

/**
 * 解析裁决器的回复。缺字段、非 JSON、action 非法、ask 文案不合格都返回 null（当这一拍失败）。
 * 只要结果、不看原因时用这个；要记日志请用 parseDecisionReport。
 * @param {string} text
 * @param {{idea?: string, why?: string}} [evidence] 传入后，ask 文案里的数字必须来自点子和理由
 * @returns {{action: 'silent'|'ask'|'do', text: string, ticket: {goal: string, brief: string}|null, reason: string}|null}
 */
export function parseDecision(text, evidence = {}) {
  const report = parseDecisionReport(text, evidence);
  return report.ok ? report.decision : null;
}
