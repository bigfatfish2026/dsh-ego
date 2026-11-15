/**
 * 提议器：一段只读 agent，任务只有一个——想一个能落地的「点子」。
 *
 * 它不许说话、不许动手、不许开票；工具白名单在 cordis.patch.yml 里，
 * 这里只负责拼提示词；回复的校验在 lib/gate.js 的 ② 那层。
 */
import {
  GA_HIT_WHY_MAX, IMPACT_SLOTS, REWRITE_CODES, ideaNumbersIn, isSelfReferential, normalizeIntent, undoHintForPlan,
} from './gate.js';
// 抠 JSON 的解析器只有一份（agent-run.js 的 extractJson），stage2 别另写一套括号配对。
import { extractJson } from './agent-run.js';

/* 校验逻辑（idea 够不够具体、回复能不能用）已经收进 lib/gate.js 的 ② 那层，
 * 这里保留原来的导出名转出去，外部 import 不用动。 */
export { IDEA_OBJECT_HINTS, isSelfReferential, parseProposal, validateIdea } from './gate.js';

/**
 * 素材池兜底。开源仓库里代码不持清单：默认方向写在 cordis.patch.yml 的
 * proposer.materials，这里只留空数组，配置漏了也不会把私人工作写出进提示词。
 * 想换方向就配 `proposer.materials`，写几条就列几条。
 *
 * 每条是一个对象 `{ text, motivation }`，两阶段（规则第六、十节）。
 * 字符串形态不再认：不做双形态解析，配置里混进老写法就是配置错，日志里会报出来。
 */
export const PROPOSER_MATERIALS = [];

/**
 * 素材的动机档位（规则第 6.1 节的 materials 标签）。
 * 未知值不拒加载，按「剔条 + 日志」处理——见 normalizeMaterials。
 */
export const PROPOSER_MOTIVATIONS = ['backlog', 'hygiene', 'sync', 'social', 'memory', 'status', 'self'];

/**
 * 把配置里的素材池收成 `{ text, motivation }` 并剔掉不合档的条目。
 * 为什么不交给 schema 的 z.enum：schema 硬拒会让整块配置加载失败，一条拼错就起不来；
 * 这里改成剔那一行 + 日志报出来，插件照常跑。
 *
 * @param {Array<{text?: unknown, motivation?: unknown}>} materials
 * @returns {{materials: Array<{text: string, motivation: string}>, dropped: Array<{text: string, motivation: string, why: string}>}}
 */
export function normalizeMaterials(materials) {
  const kept = [];
  const dropped = [];
  for (const item of Array.isArray(materials) ? materials : []) {
    const text = String(item?.text ?? '').trim();
    const motivation = String(item?.motivation ?? '').trim();
    if (!text) {
      dropped.push({ text, motivation, why: 'text 是空的' });
    } else if (!PROPOSER_MOTIVATIONS.includes(motivation)) {
      dropped.push({ text, motivation, why: `motivation「${motivation}」不在档位里` });
    } else {
      kept.push({ text, motivation });
    }
  }
  return { materials: kept, dropped };
}

/**
 * 自我优化方向的冷却期：同一个方向 12 小时内不提第二遍。
 * 为什么是 12 小时（从 48h 收紧到 12h）：48 小时里自指素材整段是死的，
 * 提议器连「插件自己」这条路都不许看，两段式又刚好要靠读格先去翻代码；
 * 12 小时跨一个晚上，同一晚不重复提，第二天还能接着看。
 */
export const SELF_OPTIMIZE_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * 按冷却期筛素材池：冷却期内把「自我优化方向」的条目临时剔掉（不改配置、不改 state）。
 * 判据跟 gate 的自指校验同一个词：条目的 text 里提到 dsh-ego 就算这个方向。
 *
 * @param {Array<{text: string, motivation: string}>} materials 配置里的素材池
 * @param {{state?: object, now?: number, cooldownMs?: number}} [context]
 *   state.lastSelfIdeaAt 是上次自指点子的时间；now 缺省 Date.now()
 * @returns {{materials: Array<{text: string, motivation: string}>, cooled: number}} cooled = 这一拍剔掉几条（0 = 没冷却）
 */
export function filterMaterialsByCooldown(materials, { state = {}, now = Date.now(), cooldownMs = SELF_OPTIMIZE_COOLDOWN_MS } = {}) {
  const list = Array.isArray(materials)
    ? materials
        .map((item) => ({ text: String(item?.text ?? '').trim(), motivation: String(item?.motivation ?? '').trim() }))
        .filter((item) => item.text)
    : [];
  const last = Number(state?.lastSelfIdeaAt) || 0;
  const window = Number(cooldownMs) > 0 ? Number(cooldownMs) : SELF_OPTIMIZE_COOLDOWN_MS;
  if (!(last > 0) || now - last >= window) return { materials: list, cooled: 0 };
  const kept = list.filter((item) => !isSelfReferential(item.text));
  return { materials: kept, cooled: list.length - kept.length };
}

/**
 * 提议器提示词。
 * @param {{now?: Date, state?: object, materials?: Array<{text: string, motivation: string}>}} input
 *   materials 覆盖默认素材池（配置项 `proposer.materials`）
 */
export function buildProposerPrompt({ now = new Date(), state = {}, materials = PROPOSER_MATERIALS } = {}) {
  // 空素材池不占位：不输出空的「可以往这些方向想」和空编号段。
  const lines = Array.isArray(materials)
    ? materials.map((item) => String(item?.text ?? '').trim()).filter(Boolean)
    : [];
  const directionLines = lines.length > 0
    ? ['可以往这些方向想（挑一个真的值得说的，别硬凑）：', ...lines.map((line, i) => `  ${i + 1}. ${line}`), '']
    : [];
  const stamp = now.toISOString();
  const lastReport = Number(state?.lastReportAt) > 0
    ? new Date(Number(state.lastReportAt)).toISOString()
    : '（还没有记录）';
  return [
    '（这是你自己开的一轮，不是谁发来的消息，别回应它，顺着做就行。）',
    '',
    '你是运行在 agent 宿主里的助手。现在只有一件事要你干：想一个「点子」。',
    '想点子的时候你手上只有只读工具（read / glob / grep / 记忆检索 / 搜索 / 主机状态），',
    '一个字都不许写、不许改、不许跑命令、不许开票、不许联系用户——那些由别人决定。',
    '',
    ...directionLines,
    `现在是 ${stamp}。上次让用户知道点事是 ${lastReport}。`,
    '上一个点子：' + (state?.lastReason ? String(state.lastReason).slice(0, 200) : '（没有）'),
    '',
    '规矩：',
    '· 点子要具体到「一句话就能说清要干什么」，而且必须自带对象和数量：',
    '  例：「example-db 的 jobs 表里有 55 条 retry 记录」——有表名、有 55 条。',
    '  反例：「整理一下仓库」「清理一堆没用的东西」——没有对象、没有数量，等于没法判。',
    '· why 里写依据：为什么值得动，一句话带数字或事实（原文没了 / 占名额 / 过期多久 / 队列多长）。',
    '· 想不出值得说的就老实认，idea 留空串，why 写清为什么今天没什么好说的。',
    '· 只输出一个 JSON 对象，别加解释、别加围栏之外的废话：',
    '{"idea": "一句话的点子（含对象 + 数量）", "why": "为什么值得说，带依据"}',
  ].join('\n');
}

/* ══ 两阶段：stage2 方案生成与解析 ═══════════════════════════════════ */

/**
 * 八类对象的 id，与 lib/grid.js 的 OBJECT_KINDS 同序同值。
 * 为什么不直接从 grid.js import：grid.js 反过来 import 本文件（冷却常量、normalizeMaterials），
 * 再 import 回去就是模块环，grid.js 顶层建 PAIR_SET 时会读到本文件还没初始化的绑定。
 * 两边一致性由 test/stage2.test.mjs 的一条断言钉住。
 */
/** stage2 第一步的结论：continue 往下动，abort 读了判断不动（规则第八节）。 */
export const STAGE2_VERDICTS = ['continue', 'abort'];

export const STAGE2_OBJECT_KINDS = ['files', 'config', 'service', 'memory', 'ticket', 'session', 'external-doc', 'external-repo'];

/** 打回重写的次数：默认 3，只许 1–5；越界夹到边界，别让配置写错就无限循环。 */
export const DEFAULT_MAX_REWRITE = 3;
export const MAX_REWRITE_LIMIT = 5;

/**
 * 归一 maxRewrite：非整数截断，<1 夹到 1，>5 夹到 5，越界打一行 warn（只提醒，不拒加载）。
 * @param {unknown} value 配置里的 proposer.maxRewrite
 * @param {{warn?: (line: string) => void}} [options]
 * @returns {number}
 */
export function clampMaxRewrite(value, { warn } = {}) {
  const say = (line) => {
    if (typeof warn === 'function') warn(line);
  };
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    say(`maxRewrite=${JSON.stringify(value)} 不是数字，按默认 ${DEFAULT_MAX_REWRITE} 跑`);
    return DEFAULT_MAX_REWRITE;
  }
  const whole = Math.trunc(raw);
  if (whole !== raw) say(`maxRewrite=${raw} 不是整数，截成 ${whole}`);
  if (whole < 1) {
    say(`maxRewrite=${raw} 小于 1，夹到 1（不重试）`);
    return 1;
  }
  if (whole > MAX_REWRITE_LIMIT) {
    say(`maxRewrite=${raw} 超过 ${MAX_REWRITE_LIMIT}，夹到 ${MAX_REWRITE_LIMIT}`);
    return MAX_REWRITE_LIMIT;
  }
  return whole;
}

/**
 * stage2 每版结束的结构化统计行。字段名固定，便于以后 grep / 解析调参：
 * `stage2_stats｜ms:…｜turns:…｜tools:…（read:… glob:… grep:… bash:…）｜files_read:…｜
 *  empty_globs:…｜out_chars:…｜verdict:…｜plan_steps:…｜est_lines:…`
 * @param {{ms?: number, turns?: number, tools?: number, read?: number, glob?: number,
 *   grep?: number, bash?: number, filesRead?: number, emptyGlobs?: number,
 *   outChars?: number, verdict?: string, planSteps?: number, estLines?: number}} [stats]
 * @returns {string}
 */
export function formatStage2Stats(stats = {}) {
  const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const verdict = String(stats?.verdict ?? '').trim() || 'unknown';
  return `stage2_stats｜ms:${n(stats?.ms)}｜turns:${n(stats?.turns)}`
    + `｜tools:${n(stats?.tools)}（read:${n(stats?.read)} glob:${n(stats?.glob)} grep:${n(stats?.grep)} bash:${n(stats?.bash)}）`
    + `｜files_read:${n(stats?.filesRead)}｜empty_globs:${n(stats?.emptyGlobs)}｜out_chars:${n(stats?.outChars)}`
    + `｜verdict:${verdict}｜plan_steps:${n(stats?.planSteps)}｜est_lines:${n(stats?.estLines)}`;
}

/**
 * 上一版方案的具体字段，打回重写时摊给模型看：
 * 原因说「哪里不合格」是结论，这些字段是它要照着改的原文，省得它猜。
 * @param {object|null} plan parseStage2Plan 的 plan
 * @returns {string[]} 空数组 = 调用方没传 plan（老调用方/单测），不硬塞一段空表
 */
export function rewriteFieldLines(plan) {
  if (!plan || typeof plan !== 'object') return [];
  const text = (value) => String(value ?? '').trim() || '（空）';
  const list = (value) => (Array.isArray(value) ? value.map((one) => String(one ?? '').trim()).filter(Boolean) : []);
  const impact = plan?.intent?.impact ?? {};
  return [
    '上一版具体字段（哪一处不合格就改哪一处，别动别的）：',
    `· object.kind / value / anchor：${text(plan?.object?.kind)} / ${text(plan?.object?.value)} / ${text(plan?.object?.anchor)}`,
    `· step1.read / verdict / abortIf：${text(plan?.step1?.read)} / ${text(plan?.step1?.verdict)} / ${text(plan?.step1?.abortIf)}`,
    `· step2.change / undo：${text(plan?.step2?.change)} / ${text(plan?.step2?.undo)}`,
    `· plan.steps：${list(plan?.plan?.steps).join('、') || '（空）'}`,
    `· plan.files：${list(plan?.plan?.files).join('、') || '（空）'}`,
    `· plan.estLines：${Number(plan?.plan?.estLines) || 0}`,
    // GA10 要对着 evidence 改：把这一版已有的 value 摊出来，模型才知道哪个数字没出处
    `· evidence[].value：${list((Array.isArray(plan?.evidence) ? plan.evidence : []).map((one) => one?.value)).join('、') || '（空）'}`,
    `· intent.reversibility / impact.paths / impact.services / impact.remotes：${text(plan?.intent?.reversibility)}`
      + ` / ${list(impact?.paths).join('、') || '（空）'} / ${list(impact?.services).join('、') || '（空）'}`
      + ` / ${list(impact?.remotes).join('、') || '（空）'}`,
    '',
  ];
}

/*
 * 重写提示词里「这一版被拦的地方 + 逐条怎么改」那一段的字数上限。
 * 曾经有一拍：三次重写 tools 全是 0，模型只拿到一条原因原文，
 * 同一批 GA7/GA10 原样活到耗尽——所以这一段要一次把整轮 ga_hits 摊开。
 */
export const REWRITE_HITS_MAX_CHARS = 1200;

/** 一段文字的字符数（CJK 按字算，不按 UTF-16 码元） */
const charCount = (text) => [...String(text ?? '')].length;

/** GA 编号排序用：GA10 排在 GA7 后面，认不出的排最后 */
const gaOrder = (ga) => {
  const n = Number(String(ga ?? '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 99;
};

/**
 * 这一版真被拦住的判定：拒项 + 能触发重写的降级项。
 * unsupported 不拦（这一批核不了 ≠ 不合格），GA11/GA13 这类没有 code 的降级也不拦，都不进这一段。
 * @param {{reject?: Array<object>, downgrade?: Array<object>}} [verdict] gate 这一版的 verdict
 * @returns {Array<{ga: string, why: string}>} 按 GA 编号升序
 */
export function rewriteBlockingHits(verdict) {
  const reject = (Array.isArray(verdict?.reject) ? verdict.reject : [])
    .map((one) => ({ ga: String(one?.ga ?? '').trim() || 'GA?', why: String(one?.why ?? '').trim() }));
  const downgrade = (Array.isArray(verdict?.downgrade) ? verdict.downgrade : [])
    .filter((one) => REWRITE_CODES.has(String(one?.code ?? '')))
    .map((one) => ({ ga: String(one?.ga ?? '').trim() || 'GA?', why: String(one?.why ?? '').trim() }));
  // 稳定排序：同一 GA 的多条（GA6 的 reversibility + impact.paths）保持 gate 给的先后
  return [...reject, ...downgrade]
    .map((one, index) => ({ ...one, index }))
    .sort((a, b) => gaOrder(a.ga) - gaOrder(b.ga) || a.index - b.index)
    .map(({ ga, why }) => ({
      ga,
      why: [...why].slice(0, GA_HIT_WHY_MAX).join('') || '（没写原因）',
    }));
}

/**
 * 按 GA 编号给一句具体修法；其它 GA 只列 why，不给模板（单子是给模型照抄的，不是讲义）。
 * @param {string} ga
 * @param {string} why gate 的原因原文
 * @param {object|null} plan 上一版整份方案（GA7 取模板、GA10 取数字用）
 * @param {Array<object>} [candidates] 这一拍的候选表，GA7 认动作类型用（plan.steps 空时靠它）
 * @returns {string} 空串 = 这一关不给修法
 */
export function rewriteGaFix(ga, why, plan = null, candidates = []) {
  const text = String(why ?? '');
  if (ga === 'GA6') {
    const slot = text.match(/intent\.impact\.(paths|services|remotes)/)?.[1];
    if (slot) {
      const label = { paths: '文件绝对路径', services: '服务名', remotes: '远端仓库' }[slot] ?? slot;
      return `把这次真要动的${label}填进 intent.impact.${slot}，别留空`;
    }
    return '把 intent.reversibility 改成候选的默认档（方案里写着哪个就用哪个）';
  }
  if (ga === 'GA7') {
    const undo = undoHintForPlan(plan, candidates);
    if (undo) {
      return `把 intent.undo.howto 写成能直接跑的撤回命令，照 ${undo.primitive} 的模板：${undo.hint}`;
    }
    return '把 intent.undo.howto 写成能直接跑的撤回命令：写清撤哪个文件的哪一处改动';
  }
  if (ga === 'GA10') {
    const known = new Set(
      (Array.isArray(plan?.evidence) ? plan.evidence : []).flatMap((item) => ideaNumbersIn(String(item?.value ?? ''))),
    );
    const missing = [...new Set(ideaNumbersIn(String(plan?.idea ?? '')))]
      .filter((number) => !known.has(number));
    if (missing.length > 0) {
      return `idea 里的数字 ${missing.join('、')} 在 evidence[].value 里没有出处：`
        + `要么新增一条 evidence，value 就写这个数字本身、claim 写它从哪来；`
        + `要么把 idea 里的这个数字删掉改成定性说法`;
    }
    return 'idea 里的数字在 evidence[].value 里没有出处：要么新增一条 evidence，value 就写这个数字本身、'
      + 'claim 写它从哪来；要么把 idea 里的这个数字删掉改成定性说法';
  }
  return '';
}

/**
 * 重写 followup 里那两段：「这一版被拦的地方」逐条列 gate 原话，紧跟「逐条怎么改」。
 * 只列这一版真拦住的（见 rewriteBlockingHits），所以每次重写带的是当轮 verdict，不是第一轮的。
 * 整段 1200 字封顶，超了从最后一条往前砍（按 GA 编号顺序保留），砍掉的写「（还有 N 条已省略）」。
 * @param {{reject?: Array<object>, downgrade?: Array<object>}} [verdict] 当轮 gate verdict
 * @param {object|null} [plan] 上一版整份方案
 * @param {Array<object>} [candidates] 这一拍的候选表（GA7 认动作类型用）
 * @returns {string[]} 空数组 = 这一版没有可重写的拦截项（judge 触发时常见），不硬塞空段
 */
export function rewriteGaLines(verdict, plan = null, candidates = []) {
  const hits = rewriteBlockingHits(verdict);
  if (hits.length === 0) return [];
  const entries = hits.map((one) => {
    const fix = rewriteGaFix(one.ga, one.why, plan, candidates);
    return {
      hit: `· ${one.ga}｜${one.why}`,
      // 修法也带 GA 号：跟上面一条一条对得上，模型不用自己数顺序
      fix: fix ? `· ${one.ga}：${fix}` : '',
    };
  });
  /** 只渲染前 keep 条；省略条数写末尾 */
  const render = (keep) => {
    const kept = entries.slice(0, keep);
    const omitted = entries.length - keep;
    const lines = ['这一版被拦的地方（gate 原话，一条一条照它改）：', ...kept.map((one) => one.hit)];
    const fixes = kept.map((one) => one.fix).filter(Boolean);
    if (fixes.length > 0) lines.push('', '逐条怎么改：', ...fixes);
    if (omitted > 0) lines.push('', `（还有 ${omitted} 条已省略）`);
    return lines;
  };
  let keep = entries.length;
  let lines = render(keep);
  while (keep > 1 && charCount(lines.join('\n')) > REWRITE_HITS_MAX_CHARS) {
    keep -= 1;
    lines = render(keep);
  }
  return [...lines, ''];
}


/**
 * 数字带量纲那一句：首写与重写两版提示词说的是同一句话，所以只在这里定义一次。
 * 这是给模型看的标注规则，不是 gate 的判定规则——gate 只核字面出处，不按量纲分计数/测量；
 * 但 arbiter 判「像不像编的」时要看到「0.1%」「37.7 度」这种标注才知道那是测量值。
 */
export const NUMBER_DIMENSION_RULE =
  '· 说数字就带量纲：概率/占比/比例写百分号（0.1%），温度写「度」，大小写 MB/GB/字节，时长写秒/毫秒，行号写「文件:行号」；别写「0.1 的可能」「几个」这种没量纲的说法。';

/**
 * 打回重写时续进同一个 stage2 会话的那条消息。
 *
 * 固定句式：原因原文（gate 的 GA 或 judge）+ 上一版的 idea/why/files + 上一版具体字段
 * + 这一版被拦的地方 + 逐条怎么改 + 硬要求（文件最多 3 条）+ 「在原方案上改，别推倒重来」。
 * 原会话里已有上一版读过的文件和思路，这条只负责纠偏；具体字段让模型知道该改哪一处，
 * 被拦的 GA 明细与修法让它知道每一处要补成什么样（不然只能照着一条原因瞎改）。
 *
 * @param {{source?: string, ga?: string, reason?: string, idea?: string, why?: string,
 *   files?: string[], plan?: object, verdict?: object}} [feedback]
 *   plan 是上一版整份方案（parseStage2Plan 的输出）；verdict 是这一版的 gate 结果（带 reject/downgrade）
 * @returns {string}
 */
export function buildStage2RewritePrompt(feedback = {}) {
  // 来源关卡：GA12 是幅度上限，GA1/GA2/GA3/GA6/GA7/GA8/GA10/GA15/GA16/GA17 是方案校验；
  // 没给 ga 的按 judge 算（老调用方只传 source='judge'）
  const ga = String(feedback?.ga ?? '').trim()
    || (/^GA\d+$/.test(String(feedback?.source ?? '').trim()) ? String(feedback.source).trim() : '');
  const sourceLabel = ga ? `gate 的 ${ga}${ga === 'GA12' ? '（幅度上限）' : '（方案校验）'}` : '终审（rewrite）';
  const files = Array.isArray(feedback?.files)
    ? feedback.files.map((one) => String(one ?? '').trim()).filter(Boolean)
    : [];
  return [
    '（这是同一拍的续写：上一版方案被打回了，接着它改，别从头重来。）',
    '',
    '上一版方案被判「打回重写」。',
    `打回来源：${sourceLabel}`,
    `原因原文：${String(feedback?.reason ?? '').trim() || '（没写原因）'}`,
    `上一版 idea：${String(feedback?.idea ?? '').trim() || '（空）'}`,
    `上一版 why：${String(feedback?.why ?? '').trim() || '（空）'}`,
    `上一版 plan.files（${files.length} 条）：${files.join('、') || '（空）'}`,
    '',
    ...rewriteFieldLines(feedback?.plan),
    ...rewriteGaLines(feedback?.verdict, feedback?.plan, feedback?.candidates),
    '硬要求：',
    '· plan.files 最多 3 条，多一个都不行；路径要写到具体文件，别写成目录。',
    '· 步骤写具体：每条说清动哪个文件、动什么；含糊的步骤换成能直接做的描述。',
    '· intent.undo.howto 写一条能直接跑的命令，别写空话。',
    '· 改完自己过一遍：idea 里每个数字都能在 evidence[].value 里找到字面相同的值。',
    NUMBER_DIMENSION_RULE,
    '· 在原方案上改，别推倒重来：已经读过的对象、核对过的事实沿用上一版，只改被打回的那几处。',
    '· 输出仍然只输出一个 JSON 对象，字段跟上一版完全一样，一次写完整。',
  ].join('\n');
}

/* 原语 impact 七枚举的映射表已挪进 gate.js（GA6 要拿它核 impact 栏），
 * 这里转出去保持旧 import 路径不变：proposer 反过来 import gate，方向不会成环。 */
export { IMPACT_SLOTS };

/** 提示词里那两行 impact 说明，按 IMPACT_SLOTS 生成，别在两处手写同一张表 */
function impactHintLines() {
  const bySlot = (slot) =>
    Object.entries(IMPACT_SLOTS)
      .filter(([, slots]) => slots.includes(slot))
      .map(([impact]) => impact)
      .join('/');
  return [
    `· intent.impact 三栏按对象类别落：改本地文件（files/config）→ paths；动服务（service）→ services，填 unit 名；` +
      `碰外部仓库（external-repo）→ remotes，填 owner/name。`,
    `· 原语默认档只是提示：${bySlot('paths')} 落 paths、${bySlot('services')} 落 services、${bySlot('remotes')} 落 remotes；` +
      `${Object.entries(IMPACT_SLOTS).filter(([, slots]) => slots.length === 0).map(([impact]) => impact).join('、')} 三栏都不用编。`,
  ];
}

/**
 * 候选行整行的长度上限。超了硬截并补 …：
 * 候选行只写指针，路径全在提示词末尾「可读位置」区块里，不在这一行占预算。
 */
export const CANDIDATE_LINE_MAX_CHARS = 200;

/**
 * 提示词末尾「可读位置」区块的封顶：
 * 单候选一行 300 字、整段 1200 字，超了按候选顺序截断并写一句省略提示。
 * 读建议从候选行挪出来单列之后，才有地方放路径全文；候选行那 200 字预算留给 head + note。
 */
export const READ_HINT_LINE_MAX_CHARS = 300;
export const READ_HINTS_SECTION_MAX_CHARS = 1200;
/** 单候选最多列几条（与 lib/read-hints.js 的 READ_HINTS_MAX_ITEMS 同值，那边是枚举上限）。 */
export const READ_HINT_LINE_MAX_ITEMS = 5;
export const READ_HINTS_SECTION_TITLE = '可读位置（按候选编号）';

/** 按码点截断文本（不是按字节，中文别截半截）。 */
function clipText(text, max = CANDIDATE_LINE_MAX_CHARS) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return chars.join('');
  if (max <= 1) return '…';
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** 按码点截断候选行。 */
function clipCandidateLine(text) {
  return clipText(text, CANDIDATE_LINE_MAX_CHARS);
}

/**
 * 候选行的渲染：`C01｜objectKind=config｜R=…｜A=…｜note｜读建议：#C01`。
 *
 * 读建议那一栏：模型只拿到 primitive + objectKind
 * 时没有实例，只能 glob 摸。原来这一栏直接列路径，head + note 已占 140 字左右，
 * 200 字预算只塞得下 1 条路径 + …，等于白搭；
 * 这一栏只留一个指针，路径在提示词末尾「可读位置（按候选编号）」里。
 *
 * @param {object} one 候选（grid.js buildGrid 的一项，readHints 可缺）
 * @returns {string} 整行封顶 CANDIDATE_LINE_MAX_CHARS
 */
export function renderCandidateLine(one = {}) {
  const read = one.read && typeof one.read === 'object' ? one.read : null;
  const action = one.action && typeof one.action === 'object' ? one.action : null;
  const kind = String(action?.objectKind ?? read?.objectKind ?? one.objectKind ?? '').trim();
  const note = String(one.note ?? '').trim();
  const readText = read ? `读 ${read.primitive}×${read.objectKind}` : '读（这一拍没写读格）';
  const actionText = action ? `动 ${action.primitive}×${action.objectKind}` : '动（单段读，只读不动）';
  const head = `${one.id}｜objectKind=${kind}｜R=${readText}｜A=${actionText}`;
  // 这一格确实没路径可给时也留着这一栏指针：模型至少知道去末尾区块看，不用 glob 死磕
  const pointer = `读建议：#${String(one.id ?? '').trim().replace(/^#+/, '')}`;
  const line = note ? `${head}｜${note}｜${pointer}` : `${head}｜${pointer}`;
  return clipCandidateLine(line);
}

/**
 * 一条候选在「可读位置」区块里的那一行：`#C01 读建议：/path/a.yml；/path/b.yml`。
 *
 * 封顶两道：
 *   · 条数：最多 READ_HINT_LINE_MAX_ITEMS 条，超了在末尾写「…等 N 条」（N 是这一格总条数）；
 *   · 字数：整行（含前缀和末尾标记）READ_HINT_LINE_MAX_CHARS 字，超了在条目边界截，
 *     不把路径切成半截——半截路径模型没法用。
 * 枚举那边（lib/read-hints.js）本来就会在末尾塞一条「还有 N 条」的计数提示，那不是路径：
 * 这里把它拆出来算进总条数，不让它占掉一条读建议的名额。
 *
 * @param {object} one 候选
 * @returns {string}
 */
export function renderReadHintLine(one = {}) {
  const id = String(one?.id ?? '').trim().replace(/^#+/, '');
  const prefix = `#${id} 读建议：`;
  const raw = Array.isArray(one?.readHints)
    ? one.readHints.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  // 枚举的「还有 N 条」是计数，不是路径
  const moreMatch = raw.length > 0 ? /^还有\s*(\d+)\s*条$/.exec(raw.at(-1)) : null;
  const hints = moreMatch ? raw.slice(0, -1) : raw;
  const restCount = moreMatch ? Number(moreMatch[1]) || 0 : 0;
  const total = hints.length + restCount;
  if (hints.length === 0) {
    return `${prefix}${restCount > 0 ? `（这一格还有 ${restCount} 条没列）` : '（这一格没有具体路径，按方向自己挑一处）'}`;
  }

  const limit = READ_HINT_LINE_MAX_CHARS;
  const kept = [];
  let used = Array.from(prefix).length;
  for (const hint of hints) {
    if (kept.length >= READ_HINT_LINE_MAX_ITEMS) break;
    const cost = Array.from(hint).length + (kept.length > 0 ? 1 : 0); // 分隔符「；」占一个字
    if (used + cost > limit) break;
    kept.push(hint);
    used += cost;
  }
  if (kept.length === 0) {
    // 单条路径自己就超一行：宁可截半截也要让模型看到开头，别整条丢掉
    return clipText(`${prefix}${hints[0]}`, limit);
  }
  const truncated = kept.length < total;
  const tail = truncated ? `…等 ${total} 条` : '';
  return clipText(`${prefix}${kept.join('；')}${tail}`, limit);
}

/**
 * 提示词末尾那段「可读位置（按候选编号）」：逐候选一行，只给路径和读法。
 *
 * 为什么单列：候选行 200 字预算里 head + note 占了 140 左右，
 * 路径列进去只放得下 1 条，模型等于还是没实例。挪到末尾之后整段 1200 字，
 * 一条候选能给到 5 条路径；候选行那栏只留 `读建议：#C01` 指针，两边靠编号对上。
 *
 * 整段封顶 READ_HINTS_SECTION_MAX_CHARS：超了按候选顺序截断，末尾写
 * 「（后 N 条候选的读建议已省略）」。没有候选时返回空串，调用方别拼空段。
 *
 * @param {Array<object>} candidates
 * @returns {string}
 */
export function buildReadHintsSection(candidates = []) {
  const list = Array.isArray(candidates) ? candidates.filter((one) => one && typeof one === 'object') : [];
  if (list.length === 0) return '';
  const header = [
    READ_HINTS_SECTION_TITLE,
    '候选行末尾的「读建议：#C0N」指的就是下面这一行，路径在这儿，别在候选行里找。',
  ];
  const lines = list.map(renderReadHintLine);
  const assemble = (keepCount) => {
    const omitted = lines.length - keepCount;
    const footer = omitted > 0 ? [`（后 ${omitted} 条候选的读建议已省略）`] : [];
    return [...header, ...lines.slice(0, keepCount), ...footer].join('\n');
  };
  let keepCount = lines.length;
  let text = assemble(keepCount);
  while (Array.from(text).length > READ_HINTS_SECTION_MAX_CHARS && keepCount > 0) {
    keepCount -= 1;
    text = assemble(keepCount);
  }
  return text;
}

/**
 * stage2 提示词：把 stage1 挑出来的那一对（读格 R → 动作格 A）走成两步。
 *
 * stage1 是纯规则枚举（lib/grid.js），代码按确定顺序挑好一对再交给模型；所以这里
 * 只有一对候选，模型的任务从「想一个点子」变成「先去读，读完再决定动不动」：
 * 第一步 step1 只读，第二步 step2 才动，读下来不值得动就 abort 收工。
 *
 * @param {Array<object>} candidates stage1 的候选（本拍只传挑中的那一格）
 * @param {Array<{text: string, motivation: string}>} materials 本拍素材池（只用来说明方向几条，不刷屏）
 * @param {{now?: Date, state?: object}} [context]
 * @returns {string}
 */
export function buildStage2Prompt(candidates = [], materials = [], context = {}) {
  const list = Array.isArray(candidates) ? candidates.filter((one) => one && typeof one === 'object') : [];
  const pool = Array.isArray(materials)
    ? materials.map((item) => String(item?.text ?? '').trim()).filter(Boolean)
    : [];
  const now = context?.now instanceof Date ? context.now : new Date();
  const state = context?.state ?? {};
  const stamp = now.toISOString();
  const lastReport = Number(state?.lastReportAt) > 0
    ? new Date(Number(state.lastReportAt)).toISOString()
    : '（还没有记录）';
  // 候选行把 R / A 两段都写出来：objectKind 那一栏取 A（单段取 R）——
  // 模型看不到这一对的动作落在哪个对象类上，就只能按 note 里的词猜，猜成 files 就是 GA2 那条「对不上」。
  // 行末的「读建议」只留 `#C01` 指针，路径在末尾「可读位置」区块里。
  const candidateLines = list.length > 0
    ? list.map(renderCandidateLine)
    : ['（这一拍没有候选对）'];
  // 提示词末尾单列的读建议区块：一次只拼一次，stage1 的提示词（buildProposerPrompt）不碰它。
  const hintsSection = buildReadHintsSection(list);
  const schema = [
    '{"pick":"C01",',
    ' "step1":{"read":"这一拍实际读过的对象实例（路径 / unit 名 / 记忆 id / URL）","verdict":"continue","abortIf":"读到什么就停"},',
    ' "step2":{"change":"一句话：动什么、动哪儿","files":["碰到的路径"],"estLines":1,"undo":"能直接跑的回滚命令"},',
    ' "idea":"一句话的方案（含对象实例 + 数量）",',
    ' "why":"为什么值得做，带依据",',
    ' "object":{"kind":"files","value":"一个纯路径或纯标识符（不带任何说明文字）","anchor":"路径:行号 / unit 名 / 记忆 id / URL@抓取时间"},',
    ' "evidence":[{"claim":"哪个数字或事实","source":"这一拍真调用过的工具名","value":"144 这种短标识，不许整句","at":"2026-11-10T05:28:00Z"}],',
    ' "plan":{"steps":["P1×files"],"files":["碰到的路径"],"estLines":0},',
    ' "intent":{"impact":{"paths":[],"services":[],"remotes":[]},',
    '  "reversibility":"auto","dryRun":{"ok":false,"detail":""},',
    '  "undo":{"kind":"git-checkout","ref":"路径","howto":"能直接跑的命令"}}}',
  ].join('\n');
  return [
    '（这是你自己开的一轮，不是谁发来的消息，别回应它，顺着做就行。）',
    '',
    '你是运行在 agent 宿主里的助手。这一拍的事分两步：先只用只读工具去读（step1），读完再决定动不动（step2）。',
    '候选是代码按「读格 × 动作格」两段枚举出来的对，不是随便列的；每一对都写清了先读哪儿、读完可以动哪儿、撤不撤得回。',
    '你手上只有只读工具（read / glob / grep / 记忆检索 / 搜索 / 主机状态），',
    '一个字都不许写、不许改、不许跑命令、不许开票、不许联系用户——那些由别人决定。',
    '',
    '候选表（这一拍代码已经挑好一对，别换别的对，也别自己造）：',
    ...candidateLines,
    '',
    ...(pool.length > 0 ? [`素材池这一拍有 ${pool.length} 条方向，候选行末尾的「种子」就是它挂的那条，别另找方向。`, ''] : []),
    `现在是 ${stamp}。上次让用户知道点事是 ${lastReport}。`,
    '上一个点子：' + (state?.lastReason ? String(state.lastReason).slice(0, 200) : '（没有）'),
    '',
    '规矩：',
    '· 回答分两段：step1 是你这一拍真读了什么、读出什么结论；step2 是读完之后动什么。这一段结构是 gate 的 GA15 硬要求。',
    '· step1.read 写这一拍真读过的对象实例（路径 / unit 名 / 记忆 id / URL），不是「打算读什么」；多读了几处就写主要的那个。',
    '· step1.read 要落到种子素材里提到的文件，别指到素材之外：种子写了具体路径就写那一处，没写文件才按方向自己挑。',
    '· 候选行末尾的「读建议」就是该踩的实例（ego 先扫过一遍）：那一栏只写 `#C0N` 指针，路径在末尾「可读位置」那段里按同一个编号查；',
    '  写了具体路径就按那几处直接读，别先 glob 扫目录摸结构；只给读法（如 memory_recall / host_status / web_search）就照那个工具用；',
    '  写「没有具体路径」再按方向自己挑一处。目录扫描最多 1 次。',
    '· step1.verdict 只有两个值：continue（读到该动的东西了，往下写 step2）、abort（读下来不值得动，收工）。',
    '· step1.abortIf 一句话写清「读到什么就停」：例「这个配置项已经没人引用就 abort」。',
    '· verdict=abort：step2 不写（或留空对象），pick 照填编号，idea 写「这一对读了几处、哪一处对不上」，why 写看到什么就停了。',
    '· verdict=continue：step2 必填，change 一句话说动什么，files 列真要碰的路径，estLines 估行数，undo 写能跑的回滚命令。',
    '  同时 plan.steps 里必须出现这一步的动作原语，且跟候选行 A 那一段对得上（候选写动 edit-file×files，steps 就得有 P2）。',
    '· 候选行 A 写「（单段读，只读不动）」时：只写 step1 + verdict=continue，step2 一律不写，plan.steps 只有读那一步，',
    '  intent.undo.howto 写「只读，无改动」并说明怎么核实的；单段读全拍最多一格，别的候选行别自己拆成单段。',
    '· pick 必须是上面那个 C 编号；这一对根本读不出东西就 pick 留空串、idea 也留空串，why 写清为什么。',
    '  注意 pick 留空和 verdict=abort 是两回事：留空 = 这一对不该进候选（对象此刻确实没新东西）；',
    '  abort = 你读了、看了、判断不动，这一步是有产出的结论，写进 step1.read 和 why 里。',
    '· 你只是提议器，不是主会话：不能替用户做决定，也不能拿「没权限联系用户」当理由——联系谁由主会话定。',
    '  留空只有一个合法依据：这一格的对象此刻确实没有可做的新东西，why 要写明是对象哪一处没了新东西。',
    '  「用户没回话」「刚打扰过用户」「这一格做过了」都不是留空理由。',
    '  正例：why「app.log 里 0 条新失败，上次 718 行那条已修掉」；反例：why「用户没回话，先不做」。',
    '· idea 一句话，自带对象实例 + 数量：有路径 / unit / 记忆 id，再加个数字。',
    '· 对象实例必须是你用只读工具真查到的，不是猜的。',
    '· object.kind 必须原样照抄候选行里的 objectKind（那一栏取的是动作格的对象类，单段读才是读格），一字不改；不许换近义词，不许换成另一个类。',
    '  八类对象是：files 文件正文（日志、脚本、数据文件）；config 配置文件（yml / json / conf / 环境变量）；',
    '  service 系统服务或常驻进程（systemd unit、守护脚本）；memory 长期记忆条目；ticket 票本身；session 会话记录；',
    '  external-doc 外部资料（网页、文档、帖子）；external-repo 外部仓库（git remote、owner/name）。',
    '  候选写 config 就写 "config"：配置类和文件类在 gate 眼里是两回事，写成 "files" 会被 GA2 当场拒。',
    '· object.value 只写一个纯路径或纯标识符，就一个：文件写到文件路径为止，unit 就写 unit 名，记忆就写 id。',
    '  不许带括号说明、不许写「第 N 行」、不许一行里列多个文件、不许夹任何解释文字；多文件一律放 plan.files。',
    '  files 类对象也一样：「/a/b.log（第 718 行）」「/a/b.log 另含 c、d」这种写法一律按查不到处理。',
    '· 行号只许出现在 object.anchor 里，格式固定「路径:行号」（例：/srv/app/logs/app.log:718）；',
    '  object.value 和 evidence.value 里都不写「第 N 行」这种形状。',
    '· evidence 每条的 value 必须是短标识：一个数字、一个路径片段或一个短字符串，不许整句、不许带解释。',
    '  idea 正文里出现的每个数字都必须在某条 evidence.value 里原样出现；给不出出处的数字就别写进 idea。',
    NUMBER_DIMENSION_RULE,
    '· idea 里尽量不写具体行号，改成描述位置：把「第 718 行」写成「唯一一行失败」，行号只留在 object.anchor 和 evidence 里。',
    '  非要写数字，就往回核一遍：那个数字在 evidence.value 里有一模一样的一条吗？没有就删掉或换成描述。',
    '· evidence 每条写「数字或事实从哪来」，source 只许写你这一拍真调用过的工具名。',
    '· plan.steps 用原语 id 写（P1 读 / P2 改文件 / P3 改配置 / P4 动服务 / P5 写记忆 / P6 删 / P7 外部通信 / P8 外部检索），最多 5 步。',
    '· plan.files 最多 3 条，只写方案真要碰的路径。',
    '· intent.reversibility 三档 auto/manual/none，不许比候选行里那个默认档更宽松。',
    ...impactHintLines(),
    '· intent.undo.howto 必须写一条实际能跑的命令，或一个能落地的具体路径；只读方案写「只读，无改动」，并说明核实过了。',
    '  禁写「…」「略」「同上」「恢复原状」「见前文」这类空话，禁只写标点——gate 的 checkUndoHowto 按「没有任何命令」拒掉整拍。',
    '  正例：`cp /srv/app/logs/app.log.bak /srv/app/logs/app.log`；反例：`…`。',
    '· dryRun 是你这一拍做过的只读验证，没把握就 ok:false。',
    '',
    '字段反例 → 正例（反例是一条被 gate 拒掉的原样写法，别照抄）：',
    '  反例 object.value："/srv/app/logs/app.log 第 718 行（另含 app.state.json、app.sh）"',
    '  正例 object.value："/srv/app/logs/app.log"',
    '  正例 object.anchor："/srv/app/logs/app.log:718"',
    '  正例 plan.files：["/srv/app/logs/app.log", "/srv/app/logs/app.state.json", "/srv/app/logs/app.sh"]',
    '  idea 里写了 718，evidence 就得补一条 {"claim":"日志第 718 行那条报错","source":"read","value":"718","at":"..."}',
    '',
    '输出前自查（三条，过一遍再交，别写长篇）：',
    '  1. object.kind 跟候选行的 objectKind 一字不差。',
    '  2. idea 里每个数字都在某条 evidence.value 里有一模一样的一条。',
    '  3. intent.undo.howto 是能跑的命令或具体路径，不是省略号。',
    '  4. step1.read / verdict / abortIf 三栏都填了，verdict 是 continue 时 step2 也在。',
    '',
    '· 只输出一个 JSON 对象，别加解释、别加围栏之外的废话：',
    schema,
    // 读建议放最后：跟候选行分开之后，这儿的路径才是完整的一串，
    // 模型读完候选行、带着编号到这一段找实例，候选行那 200 字预算只留给 head + note。
    ...(hintsSection ? ['', hintsSection] : []),
  ].join('\n');
}

/** 字符串字段：不是字符串就是空串（缺字段不抛，交给调用方按必填判） */
const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * 解析 stage2 的回复。
 *
 * 校验口径照规则第八、九节的 schema 表与 GA15：
 *   pick 是候选 id 或空串（空 = 这一对不该进候选，只要求 idea / why）；
 *   pick 非空时 step1 三栏（read / verdict / abortIf）必填，verdict 只认 continue / abort；
 *   verdict=continue 时 step2 必填（change 一句话，undo 能跑），object（kind/value/anchor）、
 *   evidence（≥1 条 claim+source）、plan.steps（≥1 步）照旧得在；
 *   verdict=abort 时 step2 不许写，object / evidence / plan 都可以缺（读了判断不动，这拍没有动作）。
 * intent 四栏缺哪栏就走 gate 的 normalizeIntent 默认，不自己补规则；step2.undo 并进
 * intent.undo.howto（模型可能只写一边），step2.files 并进 plan.files。
 *
 * 失败分三类，调用方按 reason 落日志（规则 5.3 的 stage2_fail:<reason>）：
 *   json   抠不出 JSON 对象
 *   schema 必填字段缺 / 类型不对
 *   pick   给了候选表里没有的编号（模型想造格子）
 *
 * @param {string} text 模型回复原文
 * @param {{candidates?: Array<{id: string, objectKind?: string}>}} [options]
 * @returns {{ok: true, plan: {pick: string, idea: string, why: string,
 *   step1: {read: string, verdict: 'continue'|'abort', abortIf: string},
 *   step2: {change: string, files: string[], estLines: number, undo: string}|null,
 *   object: object|null, evidence: Array<object>,
 *   plan: {steps: string[], files: string[], estLines: number},
 *   intent: object|null}} | {ok: false, reason: string, detail: string}}
 */
export function parseStage2Plan(text, { candidates = [] } = {}) {
  const value = extractJson(text);
  if (!value) return { ok: false, reason: 'json', detail: '回复里抠不出 JSON 对象' };

  const allowed = new Map(
    (Array.isArray(candidates) ? candidates : [])
      .filter((one) => one && typeof one === 'object' && one.id)
      .map((one) => [String(one.id), one]),
  );
  if (typeof value.pick !== 'string') {
    return { ok: false, reason: 'schema', detail: 'pick 不是字符串（不值得做就写空串，别省这个键）' };
  }
  const pick = value.pick.trim();
  if (pick && !allowed.has(pick)) {
    const known = [...allowed.keys()].join('/') || '（这一拍没有候选）';
    return { ok: false, reason: 'pick', detail: `pick=${pick} 不在候选表里，候选只有 ${known}` };
  }
  if (typeof value.idea !== 'string' || typeof value.why !== 'string') {
    return { ok: false, reason: 'schema', detail: 'idea / why 必须是字符串' };
  }
  const idea = value.idea.trim();
  const why = value.why.trim();

  // 空 pick = 今天没话说：只要求 idea 和 why，其余字段可缺（规则 5.2）
  if (!pick) {
    return {
      ok: true,
      plan: {
        pick: '',
        idea,
        why,
        step1: null,
        step2: null,
        object: null,
        evidence: [],
        plan: { steps: [], files: [], estLines: 0 },
        intent: normalizeIntent(legacyIntentSource(value)),
      },
    };
  }

  // step1：两步式的第一步，结构由 GA15 兜底，这里只做形状校验（规则第八节）
  const rawStep1 = value.step1;
  if (!rawStep1 || typeof rawStep1 !== 'object' || Array.isArray(rawStep1)) {
    return { ok: false, reason: 'schema', detail: 'step1 必须是一个对象（read / verdict / abortIf）' };
  }
  const step1Read = asText(rawStep1.read);
  if (!step1Read) return { ok: false, reason: 'schema', detail: 'step1.read 是空的（这一拍真读了什么，不是打算读什么）' };
  const verdict = asText(rawStep1.verdict).toLowerCase();
  if (!STAGE2_VERDICTS.includes(verdict)) {
    return {
      ok: false,
      reason: 'schema',
      detail: `step1.verdict=${JSON.stringify(rawStep1.verdict)} 只认 continue / abort（读了不值得动就 abort）`,
    };
  }
  const abortIf = asText(rawStep1.abortIf);
  if (!abortIf) return { ok: false, reason: 'schema', detail: 'step1.abortIf 是空的（读到什么就停，一句话）' };

  const step1 = { read: step1Read, verdict, abortIf };
  const step2 = parseStep2(value.step2);

  // verdict=abort：读了判断不动。step2 不许有（有就让 GA15 拒，这里保留原样往下走），
  // 对象 / 证据 / 计划都可以缺——这一拍本来就没有动作。
  if (verdict === 'abort') {
    return {
      ok: true,
      plan: {
        pick,
        idea,
        why,
        step1,
        step2,
        object: null,
        evidence: [],
        plan: { steps: [], files: [], estLines: 0 },
        intent: normalizeIntent(legacyIntentSource(value)),
      },
    };
  }

  const rawObject = value.object;
  if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) {
    return { ok: false, reason: 'schema', detail: 'object 必须是一个对象（kind / value / anchor）' };
  }
  const kind = asText(rawObject.kind).toLowerCase();
  if (!STAGE2_OBJECT_KINDS.includes(kind)) {
    return {
      ok: false,
      reason: 'schema',
      detail: `object.kind=${JSON.stringify(rawObject.kind)} 不是八类对象之一（${STAGE2_OBJECT_KINDS.join('/')}）`,
    };
  }
  const objectValue = asText(rawObject.value);
  if (!objectValue) return { ok: false, reason: 'schema', detail: 'object.value 是空的（对象实例要写成具体那个）' };
  const anchor = asText(rawObject.anchor);
  if (!anchor) return { ok: false, reason: 'schema', detail: 'object.anchor 是空的（文件:行号 / unit 名 / 记忆 id / URL@抓取时间）' };

  const rawEvidence = value.evidence;
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
    return { ok: false, reason: 'schema', detail: 'evidence 至少要一条（数字或事实从哪来）' };
  }
  const evidence = [];
  for (const item of rawEvidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'schema', detail: 'evidence 每项都要是对象（claim / source / value / at）' };
    }
    const claim = asText(item.claim);
    const source = asText(item.source);
    if (!claim) return { ok: false, reason: 'schema', detail: 'evidence 里有条目没写 claim' };
    if (!source) return { ok: false, reason: 'schema', detail: 'evidence 里有条目没写 source（哪条工具跑出来的）' };
    evidence.push({ claim, source, value: asText(item.value), at: asText(item.at) });
  }

  const rawPlan = value.plan;
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return { ok: false, reason: 'schema', detail: 'plan 必须是一个对象（steps / files / estLines）' };
  }
  const steps = Array.isArray(rawPlan.steps)
    ? rawPlan.steps.map((one) => String(one ?? '').trim()).filter(Boolean)
    : [];
  if (steps.length === 0) {
    return { ok: false, reason: 'schema', detail: 'plan.steps 至少要一步（用原语 id 写，例：P1×files）' };
  }
  const planFiles = Array.isArray(rawPlan.files)
    ? rawPlan.files.map((one) => String(one ?? '').trim()).filter(Boolean)
    : [];
  const estLines = Number(rawPlan.estLines);
  const step2Lines = Number(step2?.estLines);
  let intent = normalizeIntent(legacyIntentSource(value));
  // step2.undo 并进 intent.undo.howto：两处写的是同一条回滚命令，模型常常只填一边。
  // 整块 intent 没写时保持 null（intentRequired 的灰度靠这个 null 判，别替它造一个空对象）
  if (step2?.undo && !asText(intent?.undo?.howto)) {
    if (!intent) intent = normalizeIntent({});
    intent.undo.howto = step2.undo;
  }
  return {
    ok: true,
    plan: {
      pick,
      idea,
      why,
      step1,
      step2,
      object: { kind, value: objectValue, anchor },
      evidence,
      plan: {
        steps,
        files: [...new Set([...planFiles, ...(step2?.files ?? [])])],
        estLines: Number.isFinite(estLines) && estLines > 0
          ? Math.round(estLines)
          : Number.isFinite(step2Lines) && step2Lines > 0
            ? Math.round(step2Lines)
            : 0,
      },
      intent,
    },
  };
}

/**
 * step2 的形状归一（规则第八节字段表）：change / files / estLines / undo。
 * 缺整个 step2 返回 null（verdict=abort 时合法，continue 时由 GA15 拒）；
 * 给了但不是对象也返回 null——那等价于「没写第二步」。
 */
function parseStep2(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const change = asText(raw.change);
  const files = Array.isArray(raw.files)
    ? raw.files.map((one) => String(one ?? '').trim()).filter(Boolean)
    : [];
  const estLines = Number(raw.estLines);
  return {
    change,
    files,
    estLines: Number.isFinite(estLines) && estLines > 0 ? Math.round(estLines) : 0,
    undo: asText(raw.undo),
  };
}

/**
 * intent 来源：优先 value.intent；规则 5.2 的 JSON 示例把 reversibility 写在顶层，
 * 那就把它并进去（只并这一个键，别的顶层字段不认）。其余归一交给 gate 的 normalizeIntent。
 */
function legacyIntentSource(value) {
  const intent = value?.intent;
  if (intent && typeof intent === 'object' && !Array.isArray(intent)) {
    if (typeof intent.reversibility !== 'string' && typeof value?.reversibility === 'string') {
      return { ...intent, reversibility: value.reversibility };
    }
    return intent;
  }
  if (typeof value?.reversibility === 'string') return { reversibility: value.reversibility };
  return null;
}
