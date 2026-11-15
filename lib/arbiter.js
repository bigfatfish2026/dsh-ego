/**
 * arbiter 关：gate（纯代码硬语法）判不了的灰色条目，打包给一只轻量 agent 逐条判。
 *
 * 为什么要这一关：gate 判不了的分支以前只记 `unsupported` 然后放行——等于闭嘴，
 * 明明看出可疑却什么都不说。现在这些条目收进 `unsure`，交到这里。
 *
 * 链条分工（谁都不许越界）：
 *   gate    判死的（形状不对、超限、白名单外）——纯代码，不问模型；
 *   veto    否决台账——纯代码，命中直接 silent；
 *   arbiter 判 gate 判不了的灰度（这一类对象核不了、锚点形状不常规、数字出处对不上）；
 *   judge   判整份方案值不值得做。
 *
 * 本文件只做「拼提示词 / 解析回复 / 跑一轮 / 合并判定 / 拼日志行」，
 * 不 import fs/path/os，也不碰任何下发动作：arbiter 只许回一段 JSON，不许开票、不许 exec。
 */
import { extractJson } from './agent-run.js';
import { REWRITE_CODES, REWRITE_GATE_ACTIONS } from './gate.js';
import { clipLogText } from './text.js';

/** 每条只能三选一：放行 / 真拒（整拍不做）/ 打回重写 */
export const ARBITER_DECISIONS = Object.freeze(['pass', 'reject', 'downgrade']);

/** why 上限跟 ga_hit 一样 240 字，日志里一行一条 */
export const ARBITER_WHY_MAX = 240;

/** 一次最多送几条（配置 arbiter.maxCases，默认 8；越界夹边界，不拒加载） */
export const ARBITER_MAX_CASES_DEFAULT = 8;
export const ARBITER_MAX_CASES_MIN = 1;
export const ARBITER_MAX_CASES_MAX = 24;

/** arbiter 的硬超时：只逐条判几行，给 2 分钟 */
export const ARBITER_TIMEOUT_MS = 120_000;

/**
 * 一次送几条：非数字 / <= 0 回落默认，小数截整，越界夹边界。
 * @param {unknown} value
 * @returns {number}
 */
export function clampArbiterMaxCases(value) {
  if (value === undefined || value === null || value === '') return ARBITER_MAX_CASES_DEFAULT;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return ARBITER_MAX_CASES_DEFAULT;
  const whole = Math.min(ARBITER_MAX_CASES_MAX, Math.max(ARBITER_MAX_CASES_MIN, Math.trunc(raw)));
  return whole;
}

/** GA 编号的数字部分，排序用；认不出给 999，排在后面 */
function gaNumber(ga) {
  const match = /^GA(\d+)$/i.exec(String(ga ?? '').trim());
  return match ? Number(match[1]) : 999;
}

/** 一条灰色条目能不能送：ga 得是 GA 编号、why 非空都算（subject 可缺） */
function isCaseLike(one) {
  return Boolean(one) && typeof one === 'object' && /^GA\d+$/i.test(String(one.ga ?? '').trim());
}

/**
 * 截断：按 GA 编号排序后取前 maxCases 条，超出的记数（调用侧打 `arbiter_case:超 N 条已略`）。
 * @param {Array<{ga: string, why?: string, subject?: string}>} cases
 * @param {number} maxCases
 * @returns {{picked: Array<object>, skipped: number, total: number}}
 */
export function selectArbiterCases(cases, maxCases = ARBITER_MAX_CASES_DEFAULT) {
  const list = Array.isArray(cases) ? cases.filter(isCaseLike) : [];
  const limit = clampArbiterMaxCases(maxCases);
  const sorted = list
    .map((one, index) => ({ one, index }))
    .sort((a, b) => gaNumber(a.one.ga) - gaNumber(b.one.ga) || a.index - b.index)
    .map((item) => item.one);
  return {
    total: list.length,
    picked: sorted.slice(0, limit),
    skipped: Math.max(0, list.length - limit),
  };
}

/** 方案片段的字段：空的一律写「（没写）」，别让模型把空缺当可以自己补 */
function field(value) {
  const text = String(value ?? '').trim();
  return text || '（没写）';
}

/**
 * arbiter 提示词：每条灰色条目给 GA 编号、gate 原文 why、涉及的方案片段，
 * 要求逐条三选一，并说明 reject / downgrade 的后果（reject = 整拍不做，
 * downgrade = 打回重写），所以只有真觉得有问题才拒。
 *
 * @param {Array<{ga: string, why?: string, subject?: string}>} cases
 * @param {{idea?: string, why?: string, object?: object, anchor?: string, step1?: object,
 *   step2?: object, files?: string[], material?: string, candidateId?: string, extra?: string}} [ctx]
 * @returns {string}
 */
export function buildArbiterPrompt(cases, ctx = {}) {
  const list = Array.isArray(cases) ? cases.filter(isCaseLike) : [];
  const files = Array.isArray(ctx?.files) ? ctx.files.map((one) => String(one ?? '').trim()).filter(Boolean) : [];
  const objectKind = String(ctx?.object?.kind ?? '').trim();
  const objectValue = String(ctx?.object?.value ?? '').trim();
  // 每条 case 都编号 + 给 gate 原文：模型要按编号逐条回，别自己合并、别自己加条目
  const caseLines = list.map((one, index) => {
    const subject = String(one?.subject ?? '').trim();
    const ga = String(one.ga).trim().toUpperCase();
    return [
      `${index + 1}. [${ga}] ${field(one?.why)}`,
      `   涉及的方案片段：${field(subject)}`,
    ].join('\n');
  });
  return [
    '（这是你自己开的一轮：下面这段不是谁发来的消息，是 gate 那一关交给你判的灰色条目。）',
    '',
    '你是 arbiter 关：gate 是纯代码的硬语法关，有些条目它判不了（这类对象没有查询源、',
    '锚点形状不常规、数字出处认不出来），于是把它们交给你。你只判这些条目该不该拦，',
    '不动手、不开票、不执行任何命令——回复里只有判断。',
    '',
    '这份方案（下面这些就是全部事实，不许自己补）：',
    `· 候选：${field(ctx?.candidateId)}`,
    `· 点子：${field(ctx?.idea)}`,
    `· 理由：${field(ctx?.why)}`,
    `· object（kind / value）：${field(objectKind)} / ${field(objectValue)}`,
    `· anchor：${field(ctx?.anchor)}`,
    `· step1.read：${field(ctx?.step1?.read)}`,
    `· step2.change：${field(ctx?.step2?.change)}`,
    `· 要动的文件：${files.length > 0 ? files.join('、') : '（没写）'}`,
    `· 素材：${field(ctx?.material)}`,
    ...(String(ctx?.extra ?? '').trim() ? [`· 补充：${String(ctx.extra).trim()}`] : []),
    '',
    `gate 判不了的条目，共 ${list.length} 条：`,
    ...(caseLines.length > 0 ? caseLines : ['（没有条目）']),
    '',
    '每条给一个决定，只能三选一：',
    '· pass —— 这条没问题，放行。gate 核不了不等于不合格，拿不准时选它。',
    '· reject —— 这条真有问题，整拍不做。代价很大：这一拍什么都不干，用户也看不见。',
    '· downgrade —— 这条可疑，打回让 stage2 改一版再判。会多跑一轮模型。',
    '只有你真觉得有问题才选 reject 或 downgrade；看不出问题就 pass，别为了显得认真硬拦。',
    '判据只看上面列的事实：路径、锚点、数字、素材对得上对不上。',
    'GA10 的一条里会列好几个缺出处的数字：逐个看，但一条只回一个决定——',
    '确实有编造的测量值就 downgrade（不用 reject），计数、日期、定性说法都不算编。',
    '带百分号/度/秒这类量纲的数字，是模型自己标的测量值，重点核它有没有出处；不带量纲的整数多半是计数，别当编造。',
    '能自己看一眼文件就看一眼（你有 read），但只许看，不许改。',
    '',
    '只输出一个 JSON 对象，别加解释、别加围栏：',
    '{"verdicts": [{"ga": "GA4", "decision": "pass|reject|downgrade", "why": "一句话原因"}]}',
    '每条一个对象，ga 照抄上面的编号，why 一句话说清。',
  ].join('\n');
}

/**
 * 解析 arbiter 的回复：只认 `{"verdicts":[...]}` 这个形状。
 * 坏 JSON / 没有 verdicts 数组 / 一条有效判定都没有 → null（调用侧按失败降级，不抛）。
 * 缺字段的条目（ga 不是 GA 编号、decision 不在三种里）跳过，其余照用。
 *
 * @param {unknown} text
 * @returns {{verdicts: Array<{ga: string, decision: string, why: string}>}|null}
 */
export function parseArbiterReply(text) {
  const json = extractJson(String(text ?? ''));
  if (!json || !Array.isArray(json.verdicts)) return null;
  const verdicts = [];
  for (const one of json.verdicts) {
    if (!one || typeof one !== 'object') continue;
    const ga = String(one.ga ?? '').trim().toUpperCase();
    const decision = String(one.decision ?? '').trim().toLowerCase();
    if (!/^GA\d+$/.test(ga)) continue;
    if (!ARBITER_DECISIONS.includes(decision)) continue;
    verdicts.push({ ga, decision, why: clipless(one.why) });
  }
  return verdicts.length > 0 ? { verdicts } : null;
}

/** why 只留一句话：日志单行 240 字封顶（跟 ga_hit 同一口径） */
function clipless(text) {
  return clipLogText(String(text ?? '').trim(), ARBITER_WHY_MAX);
}

/** 失败原因归一成短词，日志里 `arbiter_fail:超时｜N 条按 unsupported 放行` 直接用 */
function failureWord(error) {
  const text = String(error ?? '');
  if (/超时|timeout|timed out/i.test(text)) return '超时';
  if (/空回复|没有回复|没等到 assistant 文本|输出预算吃完了|empty/i.test(text)) return '空回复';
  return '调用失败';
}

/** 空正文重试时追加的最后一句：把「只要 JSON」再钉一遍 */
export const ARBITER_RETRY_HINT = '直接给 JSON，别解释。';

/**
 * 这条失败算不算「空正文」、值不值得重试一次。
 *
 * 只认正文空这一种：agent-run 把空正文归成两类文案（没等到 assistant 文本 /
 * 输出预算吃完了），调用侧也可能直接给「空回复」。超时、网络错、坏 JSON 都不重试——
 * 同样的参数再跑一次只是白烧钱和白等一个超时。
 */
export function isEmptyReply(error) {
  const text = String(error ?? '');
  return /没等到 assistant 文本|输出预算吃完了|空回复|没有回复|empty/i.test(text);
}

/** 重试用的提示词：原文不动，只在末尾补一句 */
export function retryPrompt(prompt) {
  return `${String(prompt ?? '').trimEnd()}\n\n${ARBITER_RETRY_HINT}`;
}

/**
 * arbiter 的 provider/model 空着就跟随提议器。
 *
 * 宿主没有「留空 = 用默认模型」这回事：dsh-agent 的 AgentModel.current() 只认
 * 显式给的 provider+model（dsh-agent/lib/index.js:193-197），空着就在
 * dsh-agent-loop 抛 "has no provider/model"，一步都不跑。配置里 arbiter 整段
 * 缺省是常态，所以在这里补一次，别让那一关 0.1 秒静默失败。
 *
 * @param {{provider?: string, model?: string}} section 配置里的 arbiter 段
 * @param {{provider?: string, model?: string}} fallback 提议器的路由
 * @returns {{section: object, followed: string[]}} followed 是补了哪几个字段
 */
export function resolveArbiterRoute(section = {}, fallback = {}) {
  const out = { ...section };
  const followed = [];
  const provider = String(out.provider ?? '').trim();
  const model = String(out.model ?? '').trim();
  if (!provider && String(fallback?.provider ?? '').trim()) {
    out.provider = String(fallback.provider).trim();
    followed.push('provider');
  }
  if (!model && String(fallback?.model ?? '').trim()) {
    out.model = String(fallback.model).trim();
    followed.push('model');
  }
  return { section: out, followed };
}

/** 重试行：`arbiter_retry:空正文重试一次｜N 条` */
export function arbiterRetryLine(count = 0) {
  return `arbiter_retry:空正文重试一次｜${Number(count) || 0} 条`;
}

/**
 * 跑一轮 arbiter：拼提示词 → 调注入的 agent → 解析。
 *
 * 失败一律降级，绝不因此拒掉整拍：
 *   · 空正文 → 同参数重试一次（提示词末尾补一句「直接给 JSON，别解释」），仍空才失败；
 *   · agent 抛错 / ok:false（超时、调用错）→ verdicts 空、failed 给短词；
 *   · 回复解析不出 → failed='坏 JSON'。
 * 调用侧拿 `failed` 非空就把这些条目全按 unsupported 放行。
 *
 * @param {{
 *   cases?: Array<{ga: string, why?: string, subject?: string}>,
 *   ctx?: object,
 *   agent?: (prompt: string) => Promise<{ok: boolean, text?: string, error?: string}>,
 *   config?: {maxCases?: number},
 * }} options
 * @returns {Promise<{
 *   verdicts: Array<{ga: string, decision: string, why: string}>,
 *   failed: string|null, total: number, sent: number, skipped: number, ms: number,
 *   retried: boolean,
 * }>}
 */
export async function runArbiter({ cases = [], ctx = {}, agent, config = {} } = {}) {
  const started = Date.now();
  const { picked, skipped, total } = selectArbiterCases(cases, config?.maxCases);
  const base = { verdicts: [], failed: null, total, sent: picked.length, skipped, ms: 0, retried: false };
  if (picked.length === 0) return base;
  if (typeof agent !== 'function') {
    return { ...base, failed: '没注入 agent', ms: Math.max(0, Date.now() - started) };
  }
  const prompt = buildArbiterPrompt(picked, ctx);
  /** 调一次；抛错归一成 ok:false，让重试判断只看一种形状 */
  const call = async (text) => {
    try {
      return await agent(text);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };
  let reply = await call(prompt);
  let retried = false;
  /*
   * 空正文兜底：一次空不算失败，重试一次。
   * 只对「空正文」这一类重试——超时 / 网络错 / 坏 JSON 重试只是白烧钱。
   * 重试不多不少只一次，两次都空才交回 failed（调用侧照旧按 unsupported 放行）。
   */
  if (isEmptyReply(reply?.error)) {
    retried = true;
    reply = await call(retryPrompt(prompt));
  }
  const ms = Math.max(0, Date.now() - started);
  if (!reply || reply.ok === false) {
    return { ...base, retried, failed: failureWord(reply?.error ?? '调用失败'), ms };
  }
  const parsed = parseArbiterReply(reply.text);
  if (!parsed) return { ...base, retried, failed: '坏 JSON', ms };
  return { ...base, retried, verdicts: parsed.verdicts, failed: null, ms };
}

/**
 * 把 arbiter 的判定合并回 gate 的 verdict。
 *
 * 铁律：arbiter 只能处置 `unsure` 里已有的条目——同一个 ga 按出现顺序配对，
 * 配不上的判定（模型编出来的 GA、多出来的条目）一律忽略，不许它去改 gate 判死的关。
 *   · pass      → 按 unsupported 处理（放行、日志里留一条未核）
 *   · reject    → 进 reject（真的拒，整拍不做）
 *   · downgrade → 进 downgrade（触发重写；该关在重写循环里就带 code，不在的照旧进终审）
 * 没被判到的条目、以及 arbiter 整体失败（verdicts 为空）时，全部按 unsupported 放行。
 *
 * @param {{verdict?: object, verdicts?: Array<object>}} input
 * @returns {{verdict: object, counts: {pass: number, reject: number, downgrade: number, ignored: number}}}
 */
export function mergeArbiterVerdicts({ verdict = {}, verdicts = [] } = {}) {
  const reject = Array.isArray(verdict.reject) ? [...verdict.reject] : [];
  const downgrade = Array.isArray(verdict.downgrade) ? [...verdict.downgrade] : [];
  const unsupported = Array.isArray(verdict.unsupported) ? [...verdict.unsupported] : [];
  const notes = Array.isArray(verdict.notes) ? [...verdict.notes] : [];
  const hits = new Set(Array.isArray(verdict.hits) ? verdict.hits : []);
  const counts = { pass: 0, reject: 0, downgrade: 0, ignored: 0 };
  // 同名 ga 可能有多条（GA3 每类对象一条）：按出现顺序配对，配过的从队列里划掉
  const queues = new Map();
  for (const one of Array.isArray(verdict.unsure) ? verdict.unsure : []) {
    const ga = String(one?.ga ?? '').trim().toUpperCase();
    if (!ga) continue;
    if (!queues.has(ga)) queues.set(ga, []);
    queues.get(ga).push(one);
  }
  for (const judgment of Array.isArray(verdicts) ? verdicts : []) {
    const ga = String(judgment?.ga ?? '').trim().toUpperCase();
    const decision = String(judgment?.decision ?? '').trim().toLowerCase();
    const queue = queues.get(ga);
    if (!queue || queue.length === 0 || !ARBITER_DECISIONS.includes(decision)) {
      counts.ignored += 1;
      continue;
    }
    const original = queue.shift();
    const why = String(judgment?.why ?? '').trim() || String(original?.why ?? '').trim();
    if (decision === 'reject') {
      reject.push({ ga, why });
      hits.add(ga);
      counts.reject += 1;
      continue;
    }
    if (decision === 'downgrade') {
      // 重写循环只认 REWRITE_CODES 里的 code；不在表里的关（GA4）不带 code，
      // 就当普通降级进终审，别硬塞一个 rewrite 循环认不出的来源
      const code = REWRITE_CODES.has(ga) ? ga : undefined;
      downgrade.push({
        ga,
        ...(code ? { code, originalAction: REWRITE_GATE_ACTIONS[ga] } : {}),
        why: `arbiter 判打回重写：${why}`,
      });
      hits.add(ga);
      counts.downgrade += 1;
      continue;
    }
    unsupported.push({ ga, why: `arbiter 判放行：${why}` });
    counts.pass += 1;
  }
  // 模型漏判 / 整轮失败的条目：没核完，按 unsupported 放行，不拦
  for (const queue of queues.values()) {
    for (const one of queue) {
      unsupported.push({ ga: String(one.ga).trim().toUpperCase(), why: String(one?.why ?? '') });
    }
  }
  const next = {
    ...verdict,
    ok: reject.length === 0,
    allowDo: reject.length === 0 && downgrade.length === 0,
    reject,
    downgrade,
    unsupported,
    notes,
    hits: [...hits],
    // 灰色条目已经处置完：别留着让调用侧再跑一遍
    unsure: [],
  };
  return { verdict: next, counts };
}

/** 汇总行：`arbiter_case:N 条｜送 X 条｜ms:Y｜pass:a｜reject:b｜downgrade:c` */
export function arbiterCaseLine({ total = 0, sent = 0, ms = 0, pass = 0, reject = 0, downgrade = 0 } = {}) {
  return `arbiter_case:${total} 条｜送 ${sent} 条｜ms:${Math.round(Number(ms) || 0)}`
    + `｜pass:${pass}｜reject:${reject}｜downgrade:${downgrade}`;
}

/** 截断行：`arbiter_case:超 N 条已略` */
export function arbiterSkipLine(skipped = 0) {
  return `arbiter_case:超 ${Number(skipped) || 0} 条已略`;
}

/** 单条判定：`arbiter_judge:GA4｜reject｜why:...`（why 240 字，跟 ga_hit 一致） */
export function arbiterJudgeLine(judgment = {}) {
  const ga = String(judgment?.ga ?? '').trim().toUpperCase() || 'GA?';
  const decision = String(judgment?.decision ?? '').trim().toLowerCase() || 'unknown';
  const why = clipless(judgment?.why) || '（没写原因）';
  return `arbiter_judge:${ga}｜${decision}｜why:${why}`;
}

/** 失败行：`arbiter_fail:超时｜N 条按 unsupported 放行` */
export function arbiterFailLine(failed = '调用失败', count = 0) {
  return `arbiter_fail:${String(failed ?? '').trim() || '调用失败'}｜${Number(count) || 0} 条按 unsupported 放行`;
}
