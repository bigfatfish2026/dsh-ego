/**
 * 终审：独立上下文的第二段 agent，只看「点子原文 + 为什么」，不给提议器的过程。
 * 四选一：silent（什么都不做，用户看不见）/ ask（跟用户说一句）/ do（直接开票）/
 * rewrite（方案能改好，打回 stage2 重写，reason 说明要改什么）。
 *
 * 裁决原则写在提示词里，这里只负责拼提示词；解析和硬校验（动作非法、ask 没话、
 * do 没目标）都收在 lib/gate.js 的 ③ 那层，原来的导出名照旧转出去。
 */
import { ASK_FORBIDDEN, ASK_MAX_CHARS, ASK_MIN_CHARS, parseDecisionReport } from './gate.js';
import { clipLogText } from './text.js';

/** judge_verdict 行里 reason 只留前 120 字：一行一条，够复盘「为什么这么判」 */
export const JUDGE_VERDICT_WHY_MAX = 120;

/**
 * 裁决结果的一行日志：四个动作都走这里，别只在终判那条路上打。
 * 格式：`judge_verdict:<do|silent|ask|rewrite>｜why:<reason 前 120 字>`。
 * @param {{action?: string, reason?: string}} decision
 * @returns {string}
 */
export function judgeVerdictLine(decision = {}) {
  const action = String(decision?.action ?? '').trim() || 'unknown';
  const why = clipLogText(decision?.reason, JUDGE_VERDICT_WHY_MAX) || '（没写理由）';
  return `judge_verdict:${action}｜why:${why}`;
}

/* 校验实现和默认值都搬去 gate.js 了；这里 re-export，外部 import 与旧测试不用动。 */
export {
  ACTIONS,
  ASK_FORBIDDEN,
  ASK_MAX_CHARS,
  ASK_MIN_CHARS,
  ASK_OBJECT_HINTS,
  BRIEF_MAX_COLUMNS,
  charLength,
  columns,
  numbersIn,
  parseDecisionReport,
  truncateColumns,
  validateAskText,
} from './gate.js';

/** 提示词和报错共用的口径说明，只在这一个地方写 */
export function askLenNote(minChars = ASK_MIN_CHARS, maxChars = ASK_MAX_CHARS) {
  return `${minChars}~${maxChars} 个字符（汉字、标点、字母、数字各算 1 个，大约 50~90 个汉字）`;
}

/** 默认口径（不传自定义规则时用） */
export const ASK_LEN_NOTE = askLenNote();

const pad = (n) => String(n).padStart(2, '0');

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

/**
 * 终审提示词：喂点子、why，外加 plan 的结构化原文（step1.read / step2.change /
 * step2.files / step2.undo / object），以及 state 里两个时间点。
 *
 * 曾经有一拍：plan 的 step1.read 是 `lib/gate.js:610-612`，终审写成 goal 时
 * 改成了 `610-615`。只给 idea/why 时它没有可抄的依据，只能自己编，所以这版把 plan 摊开，
 * 并在提示词里明令「路径和行号只能来自这些字段」。真正的硬校验在 gate.guardGoal。
 */
export function buildJudgePrompt({
  idea,
  why,
  plan = null,
  now = new Date(),
  state = {},
  lastReportAt = state?.lastReportAt,
  lastAskAt = state?.lastAskAt,
  recentVeto = [],
  rules = {},
} = {}) {
  const minChars = Number(rules?.minChars) > 0 ? Number(rules.minChars) : ASK_MIN_CHARS;
  const maxChars = Number(rules?.maxChars) > 0 ? Number(rules.maxChars) : ASK_MAX_CHARS;
  const forbidden = Array.isArray(rules?.forbidden) && rules.forbidden.length > 0 ? rules.forbidden.map(String) : ASK_FORBIDDEN;
  const lenNote = askLenNote(minChars, maxChars);
  const isoNow = now.toISOString();
  // plan 可以整份传进来（index.js 就是这么传的）：idea/why 缺省从 plan 里取
  const source = plan && typeof plan === 'object' ? plan : {};
  const ideaText = String(idea ?? '').trim() || String(source.idea ?? '').trim();
  const whyText = String(why ?? '').trim() || String(source.why ?? '').trim();
  const files = Array.isArray(source?.step2?.files) ? source.step2.files.map((one) => String(one ?? '').trim()).filter(Boolean) : [];
  // 空栏写「（没写）」，别让模型把空缺当成可以自己补
  const field = (value) => String(value ?? '').trim() || '（没写）';
  // 时间戳为空就整段写「（没记过）」，别再套一层括号
  const stamp = (ts) => {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '（没记过）';
    return `${formatTime(n)}（${formatGap(n, now.getTime())}）`;
  };
  // 规则第八节：只给 60 天内最近 5 条，空台账整段不出现
  const vetoes = (Array.isArray(recentVeto) ? recentVeto : [])
    .filter((one) => one && Number.isFinite(Number(one.ts)) && Number(one.ts) > 0)
    .slice(0, 5);
  const recentVetoSection = vetoes.length > 0
    ? [
        '',
        '最近 5 条被用户否掉的方向（这些是用户否掉的，别重提）：',
        ...vetoes.map((one) => {
          const direction = String(one.brief || one.comboKey || '').trim() || '（没写方向）';
          const reason = [...String(one.reason ?? '').trim()].slice(0, 40).join('') || '（没写原因）';
          return `· ${formatTime(one.ts)} ${direction} — ${reason}`;
        }),
        '撞上其中任何一条同方向，只能输出 silent：不许 ask、不许 do、不许 rewrite。',
      ]
    : [];
  return [
    '（这是你自己开的一轮：下面这段不是谁发来的消息，是上一段「提议器」交给你的一句点子和它的理由。）',
    '',
    '你是一个运行在 agent 宿主里的助手。这一轮只做裁决：这件事，做还是不做？',
    '你看不到提议器的过程，也不许自己动手——回复里只有判断。',
    '',
    '方案原文（下面这些就是全部事实，写 goal 时只能照抄，不许自己补）：',
    `· 点子：${ideaText || '（空）'}`,
    `· 理由：${whyText || '（空）'}`,
    `· step1.read（读了哪几行，原文含「路径:行号」）：${field(source?.step1?.read)}`,
    `· step2.change（要改什么）：${field(source?.step2?.change)}`,
    `· step2.files（要动的文件）：${files.length > 0 ? files.join('、') : '（没写）'}`,
    `· step2.undo（撤回命令和备份路径）：${field(source?.step2?.undo)}`,
    `· object（kind / value）：${field(source?.object?.kind)} / ${field(source?.object?.value)}`,
    ...recentVetoSection,
    '',
    '你写 goal 时，路径和行号只能来自上面这些字段，不许自己编；不确定就照抄原文。',
    '',
    `现在是 ${isoNow}。`,
    `上次让用户知道点事：${stamp(lastReportAt)}。`,
    `上次问用户：${stamp(lastAskAt)}。`,
    '',
    '四个选项，只能选一个：',
    '· silent —— 什么都不做。用户什么都看不见，这是默认答案。',
    '· ask —— 跟用户说一句话，把决定权交给她。text 就是你打算说的那句话。',
    '· do —— 直接开票让小事自己做完。ticket.goal 写要干什么，ticket.brief 写一句票面（不超过 17 个汉字）。',
    '· rewrite —— 方案本身能改好，但不该按现在这样开票：文件超过 3 条、步骤写得含糊、路径写成目录、undo 缺命令。',
    '  选 rewrite 时 reason 必须写清「要改什么」，这句会原样喂回 stage2 让它接着改；text / ticket 都留空。',
    '',
    'do 必须带 intent，这一栏是给 dispatcher 的撤回账本用的，不许省：',
    '· intent.reversibility 三档，只能选一个：',
    '  auto —— 能自己撤回来（重跑一遍、删掉重生成、改坏的代码能从 git 里捞回来、只是查一查）。',
    '  manual —— 要人工按 undo 一步步动手撤（改配置、改数据、动服务）。这一档 impact 不许全空。',
    '  none —— 撤不回来（推到远端、发消息、删了不恢复）。none 绝不许出 do，这种只能 ask 交给人。',
    '· intent.impact：paths 改哪些文件、services 动哪个服务、remotes 碰哪个远端仓库；',
    '  三项都可以是空数组，但 reversibility=manual 时不许三项全空——不然账本里没有撤回依据。',
    '· intent.undo.howto：必须写一条实际能跑的命令，或一个能落地的具体路径，例：「git checkout -- lib/gate.js」。',
    '  只读方案写「只读，无改动」，并跟一条能跑的命令（例：「只读，无改动；复核用 git status --short」）——',
    '  光写汉字、没有命令，gate 的 checkUndoHowto 按「没有任何命令」拒掉整拍。',
    '  禁「…」「略」「同上」「恢复原状」「无需撤回」，也不许只写「回滚」两个字；',
    '  正例：「cp /path/a.bak /path/a」；反例：「无需撤回：只读核查」。',
    '· action=do 时 ticket.goal 也别只写「不改任何文件」当撤回说明：撤回依据只认 undo.howto 这一栏。',
    '· intent.dryRun：{"ok": true|false, "detail": "怎么验证的（跑哪个测试 / 哪条只读命令）"}。',
    '  没把握就写 ok=false 并在 detail 里说清缺什么，别硬写 true。',
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
    '1. 动作小到不需要重启、而且 intent.reversibility 不是 none（auto 或 manual 且撤回依据写全）→ do。',
    '2. 删日志、清备份、清缓存、删文件这类删了不可恢复的 → 只能 ask，绝不许 do。',
    '3. 汇报类（账号用量、整理结果、机器状态）先看上面「上次让用户知道点事」：',
    '   不到 1 天就 silent，超过 1 天才考虑 ask 或 do。一天最多打扰用户一次。',
    '4. 拿不准就 ask，不要硬做。',
    '5. 纯闲聊、没实际内容、点子太泛落地不了 → silent。',
    '6. 用户这会儿不需要知道的事，别为了刷存在感说。',
    '',
    '只输出一个 JSON 对象，别加解释：',
    '{"action": "silent|ask|do|rewrite", "text": "action=ask 时说给用户的那句话（按上面 ask 的规矩），别的时候留空串",',
    ' "ticket": {"goal": "要干什么", "brief": "票面一句话",',
    '   "intent": {"reversibility": "auto|manual|none",',
    '     "impact": {"paths": ["改的文件"], "services": ["动的服务"], "remotes": ["碰的远端"]},',
    '     "dryRun": {"ok": true, "detail": "怎么验证的"},',
    '     "undo": {"kind": "git-checkout|rerun|restore-file", "ref": "文件或提交号", "howto": "撤回的具体命令"}}},',
    ' "reason": "一句理由"}',
  ].join('\n');
}

/**
 * 这一拍真喂给终审的字段名（只记名字，不记全文，省日志）。
 * 顺序跟提示词里「方案原文」那段一致；空栏不进列表。
 * @param {object} plan stage2 的方案原文
 * @returns {string[]}
 */
export function judgeFieldNames(plan = {}) {
  const has = (value) => String(value ?? '').trim().length > 0;
  const names = [];
  if (has(plan?.idea)) names.push('idea');
  if (has(plan?.why)) names.push('why');
  if (has(plan?.step1?.read)) names.push('step1.read');
  if (has(plan?.step2?.change)) names.push('step2.change');
  if (Array.isArray(plan?.step2?.files) && plan.step2.files.some((one) => String(one ?? '').trim())) {
    names.push('step2.files');
  }
  if (has(plan?.step2?.undo)) names.push('step2.undo');
  if (has(plan?.object?.kind)) names.push('object.kind');
  if (has(plan?.object?.value)) names.push('object.value');
  return names;
}

/**
 * 解析终审的回复。缺字段、非 JSON、action 非法、ask 文案不合格都返回 null（当这一拍失败）。
 * 只要结果、不看原因时用这个；要记日志请用 parseDecisionReport。
 * @param {string} text
 * @param {{idea?: string, why?: string}} [evidence] 传入后，ask 文案里的数字必须来自点子和理由
 * @returns {{action: 'silent'|'ask'|'do'|'rewrite', text: string, ticket: {goal: string, brief: string}|null, reason: string}|null}
 */
export function parseDecision(text, evidence = {}) {
  const report = parseDecisionReport(text, evidence);
  return report.ok ? report.decision : null;
}
