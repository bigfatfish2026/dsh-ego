/**
 * 校验层的 Gate：架构图上 ② 与 ③ 两层的代码实现，只做「这段回复能不能用」的判断。
 *
 * 图上两层：
 *   ② Gate·代码规则 —— 看提议器的回复。`checkProposal` 拆开是
 *      parseProposal（原 proposer.js:87）与 validateIdea（原 proposer.js:28）：
 *      必须是 JSON、idea/why 都得是字符串、idea 自带数量（空串 = 今天没话说，合法），
 *      配了 objectHints 时还要写清对象（有标识符或命中名词表）。
 *   ③ Gate·LLM 裁决 —— 看终审的回复。`checkDecision` 拆开是
 *      parseDecisionReport（原 judge.js:264）与 validateAskText（原 judge.js:87）：
 *      action 只能 silent/ask/do/rewrite；ask 文案要过字数、禁词、单问句、对象这四关，数字出处只记警告；
 *      do 的 ticket.goal 不能空，brief 截到 34 列。
 *
 * 这里只收校验，不拼提示词、不发消息、不写 state。proposer.js / judge.js 保留原来的
 * 导出名做薄包装转出去，index.js 则建一个 Gate 一次，一拍里两段都调它。
 *
 * 行为与重构前完全一致：外部 import 的函数名、入参、返回形状、失败分支都没动，
 * 只是把实现从两个文件挪到这一个文件。
 */
import { extractJson } from './agent-run.js';
import { clipLogText } from './text.js';

/**
 * 补括号日志的出口。这一层是纯校验、没有注入 logger 的口子，默认打一行到 console；
 * 调用方/测试可以用 `evidence.log` 接走，别再另开一套。
 */
function logJsonRepair(line) {
  try {
    console.log(line);
  } catch {
    /* 日志打不出来不影响校验 */
  }
}

/* ══ ② Gate·代码规则：提议器回复 ══════════════════════════════════════ */

/**
 * 自我指涉的判据：点子要改的是这个插件自己的源码。
 * 只认「dsh-ego」这个词：`plugins/dsh-ego`、`dsh-ego/lib/gate.js` 都命中，别的仓库名不会。
 */
export const SELF_REF_PATTERN = /dsh-ego/;

/**
 * 「文件:行号」的形状：`lib/gate.js:36`、`~/fatfish/plugins/dsh-ego/lib/route.js:104-108`。
 * 光写「某个文件」不算数：没有行号就落不到具体的几行代码上。
 *
 * 认三种名字，别的一律不算：
 *   ① 带扩展名：调研文档第五节 G1 那六个（js/mjs/cjs/yml/yaml/md）不动，
 *      加常见代码/配置后缀 json/ts/tsx/sh/toml/ini/conf/txt/lock；
 *   ② 没有扩展名的固定名：`.gitignore` 这类隐藏配置项 + `Dockerfile`/`Makefile`；
 *   ③ 名字后头还能再带一段 `.bak-20261117` 这种备份戳（`package.json.bak-20261117:19`）。
 * 冒号前的名字必须有上面某个后缀或落在固定名里，所以 `http://10.0.0.5:8080`、
 * 裸时间 `12:30`、ISO `2026-11-18T00:34:21Z`、`GA8:1` 这些都不算「文件:行号」。
 */
const FILE_LINE_EXTS = 'js|mjs|cjs|yml|yaml|md|json|ts|tsx|sh|toml|ini|conf|txt|lock';
const FILE_LINE_BARE = '\\.(?:gitignore|npmignore|dockerignore|gitattributes|editorconfig|env)|Dockerfile|Makefile';
export const FILE_LINE_PATTERN = new RegExp(
  `(?:[A-Za-z0-9_./-]*/)?(?:(?:[A-Za-z0-9_-]+\\.)+(?:${FILE_LINE_EXTS})|${FILE_LINE_BARE})`
    + '(?:[.-][A-Za-z0-9_-]+)*:\\d+(?:-\\d+)?',
);

/** 这句话是不是在说「改 ego 自己」 */
export function isSelfReferential(text) {
  return SELF_REF_PATTERN.test(String(text ?? ''));
}

/** 这句里有没有「文件:行号」 */
export function hasFileLine(text) {
  return FILE_LINE_PATTERN.test(String(text ?? ''));
}

/**
 * 素材正文里能认出来的文件锚点（带扩展名的路径）。
 * GA17 只拿它判「有没有锚点」；锚点指向得对不对，不是代码能判的，交给 arbiter。
 */
const MATERIAL_FILE_PATTERN = /[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|json|yml|yaml|md|log|sh|conf|ini|toml)/g;

/** 文本里认出来的文件路径（保留目录分量，剥掉 `./`）。不做「像不像占位符」的猜。 */
function filePathsIn(text) {
  const out = new Set();
  for (const item of String(text ?? '').matchAll(MATERIAL_FILE_PATTERN)) {
    const parts = item[0].split('/').filter((one) => one && one !== '.');
    if (parts.length > 0) out.add(parts.join('/'));
  }
  return [...out];
}

/** 素材里的文件锚点。 */
export function materialFilePaths(text) {
  return filePathsIn(text);
}

/**
 * 查 idea 够不够具体（原 proposer.js:28）。
 * @param {string} idea
 * @param {{objectHints?: string[]}} [options] 覆盖默认对象名词表（配置项 `proposer.objectHints`）
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateIdea(idea, { objectHints = [] } = {}) {
  const raw = String(idea ?? '').trim();
  if (!raw) return { ok: true, problems: [] }; // 空串 = 今天没话说，合法
  const hints = Array.isArray(objectHints) ? objectHints.map(String).filter((word) => word.trim()) : [];
  const problems = [];
  if (!/\d/.test(raw)) problems.push('没写数量（要动几条 / 几个 / 哪几处）');
  const hasIdentifier = /[A-Za-z][A-Za-z0-9_.\-/]{2,}/.test(raw);
  // 词表为空 = 没配清单，不拿名词卡对象；否则「hints 为空」会把所有点子都判死。
  const hasObjectNoun = hints.some((word) => raw.includes(word));
  if (hints.length > 0 && !hasIdentifier && !hasObjectNoun) {
    problems.push('没写对象（表名 / 路径 / 服务 / 文件）');
  }
  // 自我改写是最容易「看着像点子、落地没抓手」的一类：提到 dsh-ego 就必须落到 文件:行号，
  // 否则「把 gate 整理一下」这种话能过全部其它门，却没法判它到底改哪几行。
  if (isSelfReferential(raw) && !hasFileLine(raw)) {
    problems.push('自我改写要写文件:行号（例：lib/gate.js:36）');
  }
  return { ok: problems.length === 0, problems };
}

/* ══ ②.5 stage2 方案校验：GA1~GA14（规则第七节）════════════════════ */

/**
 * 原语别名 → 规则 id。grid.js 里有一份更全的（带配置键与 P 序号），
 * 但 grid import gate（isSelfReferential），gate 再 import grid 就是模块环，
 * 所以这里留一份只读表；两边一致性由 test/gate-stage2.test.mjs 钉住。
 * 认三种写法：`P6` / `delete` / `delete`（配置键小写同形）。
 */
const GA_PRIMITIVE_ALIASES = new Map([
  ['inspect', 'inspect'], ['p1', 'inspect'],
  ['edit-file', 'edit-file'], ['editfile', 'edit-file'], ['p2', 'edit-file'],
  ['edit-config', 'edit-config'], ['editconfig', 'edit-config'], ['p3', 'edit-config'],
  ['service', 'service'], ['p4', 'service'],
  ['memory-write', 'memory-write'], ['memorywrite', 'memory-write'], ['p5', 'memory-write'],
  ['delete', 'delete'], ['p6', 'delete'],
  ['outbound', 'outbound'], ['p7', 'outbound'],
  ['external-research', 'external-research'], ['externalresearch', 'external-research'], ['p8', 'external-research'],
  ['draft', 'draft'], ['p9', 'draft'],
]);

/** 对象类别别名 → 规则 id（`ext-doc`、`externalDoc` 都认）。同 grid.js 的 OBJECT_ALIASES。 */
const GA_OBJECT_ALIASES = new Map([
  ['files', 'files'], ['config', 'config'], ['service', 'service'], ['memory', 'memory'],
  ['ticket', 'ticket'], ['session', 'session'],
  ['external-doc', 'external-doc'], ['externaldoc', 'external-doc'], ['ext-doc', 'external-doc'],
  ['external-repo', 'external-repo'], ['externalrepo', 'external-repo'], ['ext-repo', 'external-repo'],
  ['plan', 'plan'],
]);

/** 撤回档的保守程度：数越大越保守。GA6 只认「方案比候选默认更宽松」，反方向放行。 */
export const REVERSIBILITY_RANK = Object.freeze({ auto: 0, manual: 1, none: 2 });

/**
 * 原语的 impact 七枚举落到 intent.impact 哪一栏（规则 9.1 的映射表）。
 * 定义放在 gate：GA6 要拿候选的 defaults.impact 去核方案有没有少写一栏，
 * 而 gate 不能 import proposer（proposer 反过来 import gate）。proposer.js 转出这个名字。
 */
export const IMPACT_SLOTS = {
  read: [],
  'local-write': ['paths'],
  process: ['services'],
  memory: [],
  irreversible: ['paths'],
  outbound: [],
  'read-remote': ['remotes'],
};

/** GA9 认的 URL 形状：`协议://...`，到空白或中文标点为止 */
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'）)，,；;：]+/gi;

/** GA9 的内网/本机地址（规则原文这四种，不加严） */
const INTERNAL_HOSTS = [/^127\.0\.0\.1$/i, /^192\.168\./, /^10\./, /\.internal$/i];

/** GA5 默认拒绝的根：`/tmp` 下的东西不归 ego 管（白名单可配，见 context.tmpAllowlist） */
export const TMP_DENY_ROOT = '/tmp';

/** 只读原语不需要 undo 模板：读完什么都不用撤。 */
const READONLY_PRIMITIVES = new Set(['inspect', 'external-research']);

/**
 * 动作侧原语（GA15/GA16 用）：两段式里 R 只许是上面那两条只读的，A 只许是这六条。
 * 与 grid.js 的 ROLE_READ / ROLE_ACTION 是同一份口径，两处一致性由单测钉住
 * （gate 不能 import grid：grid → proposer → gate 已经是环了）。
 */
const ACTION_PRIMITIVES = new Set(['edit-file', 'edit-config', 'service', 'memory-write', 'delete', 'outbound', 'draft']);

/** stage2 第一步的两种结论（GA15 用）：continue 往下动，abort 读了判断不动。 */
const STAGE2_VERDICTS = ['continue', 'abort'];

/** 允许出「单段只读」的动机（GA15 用）：与 grid.js SINGLE_READ_MOTIVATIONS 同一份口径。 */
const SINGLE_READ_MOTIVATIONS = ['hygiene', 'status'];

/**
 * GA7 的 undo 模板：按原语给一组宽正则，命不中才降级。
 * 口径照规则第七节那四份（P2 git checkout、P3 cp 备份、P4 systemctl start、P5 覆盖写回），
 * 另外给 delete 一条（先备份再删）。写宽一点：误伤一条好方案比放过一条空话更贵。
 */
const UNDO_TEMPLATES = {
  'edit-file': /git\s+(checkout|restore)\b|\bcp\b|\bmv\b|\bgit\s+stash\b/i,
  'edit-config': /git\s+(checkout|restore)\b|\bcp\b|\btee\b|\bcat\s*>\s*/i,
  service: /systemctl\s+(start|restart|enable)\b/i,
  'memory-write': /写回|覆盖|回填|memory[_-]?write|删除该条|删掉该条/i,
  delete: /git\s+(checkout|restore)\b|\bcp\b|\bmv\b|备份|从备份/i,
  /*
   * 写方案 = 新建一份计划文档，撤回就是删掉它：`rm plans/backlog-*.md` / unlink /
   * 从备份拷回。（不给模板的话 GA7 只剩「别写空话」那一半，撤回写「…」也会放行。）
   */
  draft: /\brm\b|\bunlink\b|删除|删掉|从备份|mv\s+.*(?:bak|backup)/i,
};

/**
 * 候选只有一种形状：`{read: {...}, action: {...}|null}`（grid.js buildGrid 的输出）。
 * 单段读时 action 是 null。上一版的平铺单格已经不再产出，这里不再兼容。
 *
 * @param {object|null} candidate
 * @returns {{read: object|null, action: object|null}}
 */
function candidateCells(candidate) {
  if (!candidate || typeof candidate !== 'object') return { read: null, action: null };
  return {
    read: candidate.read && typeof candidate.read === 'object' ? candidate.read : null,
    action: candidate.action && typeof candidate.action === 'object' ? candidate.action : null,
  };
}

/**
 * 方案主体该按哪一格判（本拍真正动手的那一格）：两段式取 A，单段取 R。
 * GA1 的开关、GA6 的默认档、GA7 的模板、GA11 的联网、GA14 的白名单都按这个口径。
 */
function mainCellOf(cells) {
  return cells.action ?? cells.read;
}

/** 把一条 `P2×files` / `edit-file` 解析成 `{primitive, objectKind}`；认不出返回 null。 */
function parseStep(step, fallbackObject = '') {
  const raw = String(step ?? '').trim();
  if (!raw) return null;
  // 步骤后面常跟一句说明（`P4×service：systemctl stop nginx`），核原语只看「P4×service」那一段
  const head = raw.split('：')[0].trim();
  const parts = head.split(/[:×|]/).map((one) => one.trim().toLowerCase());
  if (parts.length === 1) {
    const primitive = GA_PRIMITIVE_ALIASES.get(parts[0]);
    return primitive ? { primitive, objectKind: fallbackObject } : null;
  }
  if (parts.length !== 2) return null;
  const primitive = GA_PRIMITIVE_ALIASES.get(parts[0]);
  const objectKind = GA_OBJECT_ALIASES.get(parts[1]);
  return primitive && objectKind ? { primitive, objectKind } : null;
}

/** 方案里所有可能藏着 URL 的字符串（GA9 用） */
function urlFields(plan) {
  const out = [];
  const push = (value) => { if (typeof value === 'string' && value) out.push(value); };
  push(plan?.idea);
  push(plan?.why);
  push(plan?.object?.value);
  push(plan?.object?.anchor);
  for (const file of Array.isArray(plan?.plan?.files) ? plan.plan.files : []) push(file);
  for (const item of Array.isArray(plan?.evidence) ? plan.evidence : []) {
    push(item?.claim);
    push(item?.value);
    push(item?.at);
  }
  return out;
}

/** 一条 URL 违不违反 GA9；返回人话原因，不违反返回空串。 */
function badUrlReason(url) {
  const match = String(url).match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!match) return '';
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return `地址协议是 ${scheme}，只能写 http(s)：${url}`;
  }
  // `file:///etc/passwd` 这种没有 host，按协议就拦了；http(s) 的 host 取到下一个分隔符为止
  const host = String(url).slice(match[0].length).split(/[/?#]/)[0].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  if (!host) return '';
  const internal = INTERNAL_HOSTS.find((one) => one.test(host));
  if (internal) return `地址指向本机或内网（${host}），ego 只许读外网：${url}`;
  return '';
}

/** 方案里提到的 URL 全扫一遍（GA9） */
function scanUrls(plan) {
  const problems = [];
  for (const text of urlFields(plan)) {
    for (const match of String(text).matchAll(URL_PATTERN)) {
      const reason = badUrlReason(match[0]);
      if (reason) problems.push(reason);
    }
  }
  return problems;
}

/** 自我指涉：方案里任意一处提到 dsh-ego（GA8） */
function planIsSelfReferential(plan) {
  const fields = [plan?.idea, plan?.why, plan?.object?.value, ...(plan?.plan?.files ?? [])];
  return fields.some((one) => isSelfReferential(one));
}

/**
 * GA6 实例级降档认的「撤不回来」动作：systemctl 的 stop / disable / mask / kill。
 * restart / start / enable 不算——起服务、重启、设自启都还能按原档位撤回去。
 * 认两种写法：systemctl 命令（中间可以夹 `--user` 这类选项），以及没写 systemctl 时
 * 跟 service / unit / 服务 这类词同处一行的 stop / disable 动词。
 */
const SYSTEMCTL_STOP = /\bsystemctl\b[^\n;|&]*?\b(stop|disable|mask|kill)\b/i;
const SERVICE_WORD = /\b(?:service|services|unit|units|daemon)\b|服务/i;
const SERVICE_STOP_VERB = /\b(?:stop|disable)\b/i;

/**
 * 方案里「要停服 / 禁服」的原文证据（GA6 实例级降档用）。
 * 只看 gate 已经读的那几处文本：plan.steps、intent.dryRun.detail、intent.undo.howto。
 * @param {object} plan
 * @returns {string} 命中的动词（stop / disable / mask / kill），没命中返回空串
 */
export function serviceStopEvidence(plan) {
  const texts = [
    ...(Array.isArray(plan?.plan?.steps) ? plan.plan.steps : []),
    plan?.intent?.dryRun?.detail,
    plan?.intent?.undo?.howto,
  ].map((one) => String(one ?? '').trim()).filter(Boolean);
  for (const text of texts) {
    const direct = String(text).match(SYSTEMCTL_STOP);
    if (direct) return direct[1].toLowerCase();
    if (SERVICE_WORD.test(text) && SERVICE_STOP_VERB.test(text)) {
      return String(text).match(SERVICE_STOP_VERB)[0].toLowerCase();
    }
  }
  return '';
}

/** outbound 白名单归一：非空字符串、去重、保序。不传当空表（= 一律不许发） */
export function normalizeOutboundTargets(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((one) => String(one ?? '').trim()).filter(Boolean))];
}

/**
 * outbound 方案的目标会话 id（GA14）。
 * 取法照规则 86 行 P7：object.value 优先；没有再翻 intent.impact 里叫
 * target / targets / sessions / session 的栏（normalizeIntent 只留 paths/services/remotes，
 * 所以后一条只在 plan 原样传进 checkStage2Plan 时才用得上）。
 * @param {object} plan
 * @returns {string[]} 去重后的目标；一个都取不到就是空数组（GA14 按违规判）
 */
export function outboundTargetsOf(plan) {
  const out = [];
  const push = (value) => {
    if (Array.isArray(value)) {
      for (const one of value) push(one);
      return;
    }
    if (value && typeof value === 'object') return;
    const text = String(value ?? '').trim();
    if (text) out.push(text);
  };
  push(plan?.object?.value);
  const impact = plan?.intent?.impact;
  if (impact && typeof impact === 'object') {
    for (const key of ['target', 'targets', 'sessions', 'session']) push(impact[key]);
  }
  push(plan?.intent?.target);
  push(plan?.intent?.targetSession);
  return [...new Set(out)];
}

/** 数字集合：字符串里的阿拉伯数字（含小数），用于 GA10 */
function numberSet(values) {
  const set = new Set();
  for (const value of values) for (const n of numbersIn(value)) set.add(n);
  return set;
}

/**
 * idea 里参与 GA10 核的数字：日期和时刻先遮掉，剩下的阿拉伯数字（含小数）逐个核。
 *
 * 只做字面抽取，不判断「这个数字算不算测量值」——那是 arbiter 的事。
 * `2026-11-08`、`16:18:01` 整段遮掉（见 maskDatesAndTimes），一个数字都不剩。
 */
export function ideaNumbersIn(text) {
  return numbersIn(maskDatesAndTimes(text));
}

/**
 * 判「打回重写」的 11 关：ga → 这一关原本的处置。
 * 原本判拒的（GA1/GA2/GA3/GA6/GA10/GA15/GA16/GA17）改成可重写降级后用满次数落 'silent'；
 * 原本判降级的（GA7/GA8/GA12）落 'ask'。
 * GA11（价格比）/ GA13（同素材）判不了，不接进 rewrite，仍是普通降级 ask；
 * GA4/GA5/GA9/GA14 保持 reject，不进循环。
 */
export const REWRITE_GATE_ACTIONS = Object.freeze({
  GA1: 'silent',
  GA2: 'silent',
  GA3: 'silent',
  GA6: 'silent',
  GA7: 'ask',
  GA8: 'ask',
  GA10: 'silent',
  GA12: 'ask',
  GA15: 'silent',
  GA16: 'silent',
  GA17: 'silent',
});

/** rewrite 循环认的 code：11 关的 ga 名 + GA12 的三个幅度分支（files / steps / estLines） */
export const REWRITE_CODES = new Set([...Object.keys(REWRITE_GATE_ACTIONS), 'files', 'steps', 'estLines']);

/** 明细行的三种处置，跟 verdict 的三个数组同名 */
export const GA_HIT_KINDS = Object.freeze(['reject', 'downgrade', 'unsupported']);

/** 原因只留一句话：日志单行 240 字封顶，超了由 clipLogText 标出原文长度 */
export const GA_HIT_WHY_MAX = 240;

/**
 * 一条 gate 判定的明细行：所有 GA1–GA17 都走这一个出口，别一条规则一种格式。
 * 格式：`ga_hit:GA6｜downgrade｜why:<一句话原因>`。
 * @param {'reject'|'downgrade'|'unsupported'} kind
 * @param {{ga?: string, why?: string}} hit
 * @returns {string}
 */
export function gateHitLine(kind, hit = {}) {
  const ga = String(hit?.ga ?? '').trim() || 'GA?';
  const why = clipLogText(hit?.why, GA_HIT_WHY_MAX) || '（没写原因）';
  return `ga_hit:${ga}｜${kind}｜why:${why}`;
}

/**
 * 把一次 verdict 摊成明细行：拒 → 降级 → 未核，顺序跟汇总行一致。
 * 汇总行照旧由 index.js 打；这些行排在汇总后面，方便 grep `ga_hit:` 一次看全。
 * @param {{reject?: Array<object>, downgrade?: Array<object>, unsupported?: Array<object>}} verdict
 * @returns {string[]}
 */
export function gateHitLines(verdict = {}) {
  const out = [];
  for (const kind of GA_HIT_KINDS) {
    const list = Array.isArray(verdict?.[kind]) ? verdict[kind] : [];
    for (const one of list) out.push(gateHitLine(kind, one));
  }
  return out;
}

/**
 * stage2 方案的同步校验（GA1/GA2/GA6/GA7/GA8/GA9/GA10/GA11/GA12/GA13/GA14 轻量版 + GA15/GA16 结构）。
 *
 * 纯函数：不读盘、不看时钟、不 import fs/path/os。GA3/GA4/GA5 要真读盘，
 * 这里只产出 `checks`（待核查项），由 createGate().checkPlan 拿注入的 deps 去跑。
 *
 * 处置口径照规则第七节：`reject` 拒（这一拍不动作）、`downgrade` 降级 ask、
 * `notes` 放行并记日志、`unsupported` 这一条这一批核不了（不是「合格」也不是「不合格」）。
 *
 * `unsure` 是「gate 判不了、但值得 arbiter 看一眼」的灰色条目：本函数只收集（带 subject，
 * 说明这条针对方案里的哪一部分），由调用侧决定送不送 arbiter；没接 arbiter 时按 unsupported
 * 放行，行为跟老版一致。凡是能靠代码判死的分支（GA2 缺矩阵、GA6 缺 defaults、
 * GA15/GA16 平铺候选）仍旧走 unsupported/降级，不往这儿挪。
 *
 * @param {object} plan parseStage2Plan 的输出
 * @param {{
 *   candidates?: Array<object>,
 *   pairs?: Set<string>|Record<string, string[]>,
 *   enabled?: {primitives?: Record<string, boolean>, objects?: Record<string, boolean>},
 *   peak?: boolean,
 *   previousMaterial?: string,
 *   tmpAllowlist?: string[],
 *   outboundTargets?: string[],
 *   singleReadCount?: number,
 * }} [context]
 * @returns {{ok: boolean, allowDo: boolean, reject: Array<{ga: string, why: string}>,
 *   downgrade: Array<{ga: string, code?: string, why: string}>, unsupported: Array<{ga: string, why: string}>,
 *   unsure: Array<{ga: string, why: string, subject?: string}>,
 *   notes: string[], hits: string[],
 *   checks: Array<{ga: string, kind?: string, value?: string, anchor?: string}>}}
 */
export function checkStage2Plan(plan, context = {}) {
  const reject = [];
  const downgrade = [];
  const unsupported = [];
  /*
   * unsure：gate 判不了、但值得让 arbiter 看一眼的灰色条目（{ga, why, subject}）。
   * 以前这些直接记 unsupported 就放行——等于看出可疑也不吭声。现在由调用侧
   * 决定送不送 arbiter；没接 arbiter 时调用侧按 unsupported 处理，行为跟老版一致。
   */
  const unsure = [];
  const notes = [];
  const hits = new Set();
  const checks = [];
  const hit = (ga) => hits.add(ga);
  /**
   * 推一条「可重写降级」：code 给 rewrite 循环认来源，originalAction 是次数用满后落回哪儿。
   * GA12 的三个幅度分支各带自己的 code（files / steps / estLines），其余用 ga 名。
   */
  const softFail = (ga, why, code = ga) => {
    downgrade.push({ ga, code, originalAction: REWRITE_GATE_ACTIONS[ga], why });
    hit(ga);
  };

  if (!plan || typeof plan !== 'object') {
    return {
      ok: false,
      allowDo: false,
      reject: [{ ga: 'GA1', why: '方案是空的，没法核' }],
      downgrade: [], unsupported: [], unsure: [], notes: [], hits: ['GA1'], checks: [],
    };
  }

  // pick 为空串 = 今天没话说，规则 5.2 允许方案只带 idea/why；没有候选可核，放行不拦
  if (!String(plan.pick ?? '').trim()) {
    return { ok: true, allowDo: true, reject, downgrade, unsupported, unsure, notes, hits: [], checks };
  }

  const candidates = Array.isArray(context.candidates) ? context.candidates : [];
  const candidate = candidates.find((one) => String(one?.id ?? '') === String(plan.pick).trim()) ?? null;
  // 两段式：候选是一对（读格 R + 动作格 A）。单段读时 action 是 null。
  const cells = candidateCells(candidate);
  const mainCell = mainCellOf(cells);
  const mainPrimitive = String(mainCell?.primitive ?? '').trim();
  const mainObjectKind = String(mainCell?.objectKind ?? '').trim();

  // ── GA1：pick 必须是本拍候选，且那一格的原语/对象在配置里开着 ──
  if (!candidate) {
    const known = candidates.map((one) => String(one?.id ?? '')).filter(Boolean).join('/') || '（这一拍没有候选）';
    softFail('GA1', `pick=${plan.pick} 不是这一拍的候选，候选只有 ${known}`);
  } else {
    const enabled = context.enabled ?? {};
    // 两段式的两格各自都要开着：R 关着就没有读那一步，A 关着就没有动作那一步，都是不该提的。
    // 只认显式 false（配置里没写这一栏 = 不表态，不按关着算）；同一类只报一格，别拿两格刷两条。
    const roles = [['读', cells.read], ['动作', cells.action]].filter(([, cell]) => Boolean(cell));
    const offPrimitive = roles.find(([, cell]) => enabled?.primitives?.[String(cell.primitiveKey ?? '')] === false);
    if (offPrimitive) {
      const [role, cell] = offPrimitive;
      softFail('GA1', `候选 ${candidate.id} 的${role}原语「${cell.primitiveKey}」在配置里是关着的，不能提`);
    }
    const offObject = roles.find(([, cell]) => enabled?.objects?.[String(cell.objectKey ?? '')] === false);
    if (offObject) {
      const [role, cell] = offObject;
      softFail('GA1', `候选 ${candidate.id} 的${role}对象类别「${cell.objectKey}」在配置里是关着的，不能提`);
    }
  }

  const objectKind = String(plan?.object?.kind ?? '').trim();
  const objectValue = String(plan?.object?.value ?? '').trim();
  const anchor = String(plan?.object?.anchor ?? '').trim();
  const steps = Array.isArray(plan?.plan?.steps) ? plan.plan.steps : [];
  const files = Array.isArray(plan?.plan?.files) ? plan.plan.files : [];
  const estLines = Number(plan?.plan?.estLines) || 0;
  const intent = plan?.intent ?? null;
  const reversibility = String(intent?.reversibility ?? '').trim().toLowerCase();

  // ── GA2：object.kind 跟 pick 那一格的对象一致；steps 的原语×对象在配对矩阵里 ──
  if (candidate && objectKind && mainObjectKind && objectKind !== mainObjectKind) {
    const which = cells.action ? '动作格' : '读格';
    softFail('GA2', `pick 的${which}是 ${mainObjectKind} 类（${candidate.id}），方案 object.kind 却写成 ${objectKind}，对不上`);
  }
  // 配对矩阵只有一种形状：grid.js 的 PAIR_SET（Set<`原语|对象`>），没有第二份写法
  if (context.pairs instanceof Set) {
    const pairSet = context.pairs;
    for (const step of steps) {
      const parsed = parseStep(step, mainObjectKind || objectKind);
      if (!parsed) {
        softFail('GA2', `plan.steps 里的「${step}」认不出是哪个原语×对象（写法例：P2×files）`);
        continue;
      }
      if (!pairSet.has(`${parsed.primitive}|${parsed.objectKind}`)) {
        softFail('GA2', `plan.steps 里的「${step}」不在配对矩阵里（${parsed.primitive} 不碰 ${parsed.objectKind}）`);
      }
    }
  } else if (steps.length > 0) {
    unsupported.push({ ga: 'GA2', why: '没给配对矩阵，steps 的原语×对象这一拍没核' });
  }

  // ── GA3/GA4/GA5：产出待核查项，由 checkPlan 用注入的 deps 跑 ──
  if (plan?.object && objectValue) {
    if (objectKind === 'files' || objectKind === 'config') {
      checks.push({ ga: 'GA3', kind: objectKind, value: objectValue });
      checks.push({ ga: 'GA5', kind: objectKind, value: objectValue });
    } else if (objectKind) {
      // service / memory / ticket / session / 外部类都没有查询源：同一个分支把事实交 arbiter
      const reason = objectKind === 'service'
        ? `服务「${objectValue}」核不了：host_status 不给 systemd unit 列表`
        : `${objectKind} 类对象「${objectValue}」要运行时上下文（recall 结果 / state / 网络）`;
      unsure.push({
        ga: 'GA3',
        why: `${reason}，这一批没有查询源`,
        subject: `object.kind=${objectKind}，object.value=${objectValue}`,
      });
    }
  }
  if (anchor) {
    if (FILE_LINE_PATTERN.test(anchor)) checks.push({ ga: 'GA4', anchor });
    else {
      unsure.push({
        ga: 'GA4',
        why: `anchor「${anchor}」不是「文件:行号」形状（unit 名 / 记忆 id / URL@时间），行号这一条不核`,
        subject: `object.anchor=${anchor}`,
      });
    }
  } else {
    unsure.push({
      ga: 'GA4',
      why: '方案没给 anchor，行号这一条没核',
      subject: `object.kind=${objectKind || '（没写）'}，object.anchor=（空）`,
    });
  }

  /*
   * GA6 的实例级那一半（规则 83 / 417 行，P4 service 的 stop/disable 是 none 档）：
   * grid.js:35 把 service 的默认档定成 manual，格子本身没办按动作内容降档，
   * 所以「stop / disable / mask / kill」这件事在 gate 里按实例判——方案写 manual 或 auto 都拒。
   * restart / start / enable 不进这一支，仍由下面「不许比候选默认更宽松」照原档位判。
   */
  const serviceStop = mainPrimitive === 'service' ? serviceStopEvidence(plan) : '';
  if (serviceStop) {
    if (reversibility !== 'none') {
      softFail(
        'GA6',
        `方案里要动服务（${serviceStop}）：stop/disable 撤不回，档要写 none`
          + `（候选 ${candidate.id} 默认写的是 ${String(candidate?.defaults?.reversibility ?? '未知')}，方案写的是 ${reversibility || '空'}）`,
      );
    }
  }

  // ── GA6：撤回档与 impact 栏不许比候选默认更宽松 ──
  if (candidate?.defaults) {
    const expected = String(candidate.defaults.reversibility ?? '').trim().toLowerCase();
    const expectedRank = REVERSIBILITY_RANK[expected];
    const gotRank = REVERSIBILITY_RANK[reversibility];
    // 实例级已经压到 none 的这一拍不再拿默认档比一次，免得同一件事报两条 GA6
    if (Number.isFinite(expectedRank) && !serviceStop) {
      if (!reversibility) {
        softFail('GA6', `方案没写 reversibility：这一格（${candidate.id}）的默认档是 ${expected}，不写就等于按最宽松的算`);
      } else if (Number.isFinite(gotRank) && gotRank < expectedRank) {
        softFail('GA6', `reversibility 写宽了：候选 ${candidate.id} 的默认档是 ${expected}，方案写的是 ${reversibility}`);
      }
    }
    const impact = String(candidate.defaults.impact ?? '').trim();
    const slots = IMPACT_SLOTS[impact] ?? [];
    const wanted = objectKind === 'external-repo' && impact === 'irreversible' ? 'remotes' : slots[0];
    if (wanted) {
      const filled = Array.isArray(intent?.impact?.[wanted]) && intent.impact[wanted].length > 0;
      if (!filled) {
        const label = { paths: '路径', services: '服务名', remotes: '远端仓库' }[wanted] ?? wanted;
        softFail('GA6', `intent.impact.${wanted} 是空的：候选 ${candidate.id} 的默认影响面是 ${impact}，要填${label}`);
      }
    }
  } else {
    unsupported.push({ ga: 'GA6', why: '没拿到本拍候选的默认档（defaults），宽松比较没做' });
  }

  // ── GA7：undo.howto 过空话表 + 匹配候选原语的模板；不合格降级 ask ──
  const howto = String(intent?.undo?.howto ?? '').trim();
  const template = mainPrimitive ? UNDO_TEMPLATES[mainPrimitive] : '';
  // 单段候选（action 为 null）本身就是只读的一步，跟只读原语一样走跳过那一支
  const readonly = Boolean(mainPrimitive) && (cells.action ? READONLY_PRIMITIVES.has(mainPrimitive) : true);
  if (!readonly) {
    const howtoCheck = checkUndoHowto(howto);
    if (!howtoCheck.ok) {
      softFail('GA7', `undo.howto 不合格（${howtoCheck.problems.join('；')}），先问一句再动手`);
    } else if (template && !template.test(howto)) {
      softFail('GA7', `undo.howto 没命中 ${mainPrimitive} 的撤回模板（例：${undoTemplateHint(mainPrimitive)}），先问一句再动手`);
    }
  } else if (!howto) {
    notes.push('只读原语，undo.howto 没写也不卡（GA7 跳过）');
  }

  // ── GA8：自指方案要有 P8 产出与本仓文件:行号 ──
  if (planIsSelfReferential(plan)) {
    const hasP8 = (Array.isArray(plan?.evidence) ? plan.evidence : []).some((item) =>
      /https?:\/\//i.test(String(item?.claim ?? '')) || /https?:\/\//i.test(String(item?.value ?? '')))
      && (Array.isArray(plan?.evidence) ? plan.evidence : []).some((item) => String(item?.at ?? '').trim());
    if (!hasP8) {
      softFail('GA8', '改的是 dsh-ego 自己，evidence 里没有一条外部资料（带 URL 和抓取时间），先问一句');
    }
    const hasRepoLine = FILE_LINE_PATTERN.test(anchor)
      || files.some((file) => FILE_LINE_PATTERN.test(String(file)));
    if (!hasRepoLine) {
      softFail('GA8', '改的是 dsh-ego 自己，却没给本仓的「文件:行号」锚点，先问一句');
    }
  }

  // ── GA9：外部地址只许 http(s)，不许本机/内网 ──
  const urlProblems = scanUrls(plan);
  for (const why of urlProblems) reject.push({ ga: 'GA9', why });
  if (urlProblems.length > 0) hit('GA9');

  // ── GA10：idea 里的数字逐个在 evidence[].value 里找字面出处；缺的汇成一条交 arbiter ──
  const evidenceValues = (Array.isArray(plan?.evidence) ? plan.evidence : []).map((item) => String(item?.value ?? ''));
  const known = numberSet(evidenceValues);
  const missingNumbers = [...new Set(ideaNumbersIn(plan?.idea ?? '').filter((n) => !known.has(n)))];
  if (missingNumbers.length > 0) {
    unsure.push({
      ga: 'GA10',
      why: `idea 里这些数字在 evidence 里没有出处：${missingNumbers.join('、')} —— 逐个看是不是编造的测量值，计数和定性说法放行`,
      subject: `idea=${String(plan?.idea ?? '').trim() || '（空）'}；evidence.value=${evidenceValues.filter(Boolean).join(' / ') || '（没写）'}`,
    });
  }
  if (estLines > 0 && files.length === 0) {
    notes.push(`estLines=${estLines} 但 plan.files 是空的，改动行数没有落点（只记日志）`);
  }

  // ── GA11：峰价禁网，按候选的原语/对象判，不看 evidence.source ──
  const goesOnline = [cells.read, cells.action].filter(Boolean).some((cell) => cell.primitive === 'external-research'
    || ['external-doc', 'external-repo'].includes(String(cell.objectKind ?? '')));
  if (context.peak === true && goesOnline) {
    downgrade.push({ ga: 'GA11', why: '现在是峰价时段，这一格要上网（外部检索），先降级成问一句' });
    hit('GA11');
  }

  // ── GA12：幅度上限 ──
  if (steps.length > 5) {
    softFail('GA12', `plan.steps 有 ${steps.length} 步，超过 5 步，先问一句`, 'steps');
  }
  if (files.length > 3) {
    // 三条幅度分支都走重写：code 是给 rewrite 循环认来源的（files / steps / estLines）
    softFail('GA12', `plan.files 有 ${files.length} 个文件，超过 3 个，先问一句`, 'files');
  }
  if (estLines > 40) {
    softFail('GA12', `estLines 估了 ${estLines} 行，超过单文件 40 行，先问一句`, 'estLines');
  }

  // ── GA13 轻校验：同一素材不许连续两拍。12h 自指冷却的准在 proposer 的 grid，这里不重复 ──
  const previous = String(context.previousMaterial ?? '').trim();
  if (previous && candidate && String(candidate.material ?? '').trim() === previous) {
    downgrade.push({ ga: 'GA13', why: '这一拍和上一拍挂着同一条素材，先问一句再动' });
    hit('GA13');
  }

  /*
   * ── GA14：outbound 的目标必须原样在白名单里（规则 86 行 P7「目标在 targetSession / 白名单」）──
   * 白名单是 opts.outboundTargets（配置项 `outboundTargets`，元素是 `c2c:<openid>` / `group:<openid>`）。
   * 空表 = 一律不许发：默认配置就是空的，outbound 原语本身也默认关着。
   * 目标一个都取不到也算违规——「没说发给谁」的发消息方案本来就不该出门。
   */
  if (mainPrimitive === 'outbound') {
    const allow = normalizeOutboundTargets(context.outboundTargets);
    const targets = outboundTargetsOf(plan);
    if (targets.length === 0) {
      reject.push({
        ga: 'GA14',
        why: 'outbound 方案没写目标（object.value 与 intent.impact 都没有），outbound 目标不在白名单里',
      });
      hit('GA14');
    } else {
      const outside = targets.filter((one) => !allow.includes(one));
      if (outside.length > 0) {
        const shown = allow.length > 0 ? allow.join('、') : '空表（一律不许发）';
        reject.push({
          ga: 'GA14',
          why: `outbound 目标不在白名单里：${outside.join('、')}（现在配的是 ${shown}）`,
        });
        hit('GA14');
      }
    }
  }

  /*
   * ── GA15：两段式结构（规则第九节）──
   * 判据只有两种合格形状：
   *   两步齐全  = step1 三栏齐 + verdict=continue + step2.change 非空 + plan.steps 里有 A 那一步
   *   单段读    = 候选 action 为 null + 动机是 hygiene/status + 全拍只有一格单段 +
   *               idea 非空 + plan.steps ≥1 + undo.howto 能过 checkUndoHowto
   * 另外 abort 是合法收工：step1 齐、verdict=abort、step2 空着就行（这一拍没有动作）。
   * 结构不齐一律打回重写（可重写降级，用满次数落回原本的「拒」= silent）。
   */
  if (!candidate) {
    // pick 没对上候选：GA1 已经拒了，结构没得核
  } else {
    const step1 = plan?.step1 && typeof plan.step1 === 'object' ? plan.step1 : null;
    const verdict = String(step1?.verdict ?? '').trim().toLowerCase();
    const step1Read = String(step1?.read ?? '').trim();
    const abortIf = String(step1?.abortIf ?? '').trim();
    const step2 = plan?.step2 && typeof plan.step2 === 'object' ? plan.step2 : null;
    const step2Change = String(step2?.change ?? '').trim();
    const single = cells.action === null;
    const motivation = String(candidate.motivation ?? '').trim();
    const singleReadCount = Number.isFinite(Number(context.singleReadCount))
      ? Number(context.singleReadCount)
      : candidates.filter((one) => one && typeof one === 'object' && 'action' in one && (one.action ?? null) === null).length;

    if (!step1 || !step1Read || !abortIf || !STAGE2_VERDICTS.includes(verdict)) {
      softFail('GA15', '两步式结构不齐：step1 要写 read（真读了哪一处）/ verdict（continue 或 abort）/ abortIf（读到什么就停）三栏');
    } else if (verdict === 'abort') {
      // 读了判断不动：这一拍没有第二步，step2 写了就是自相矛盾
      if (step2Change) {
        softFail('GA15', 'step1.verdict=abort 却写了 step2.change：读了判断不动，就不该有第二步');
      }
    } else if (single) {
      // 单段只读：只读一步，产出是结论不是改动
      if (!SINGLE_READ_MOTIVATIONS.includes(motivation)) {
        softFail('GA15', `候选 ${candidate.id} 是单段读（action 为空），但动机是 ${motivation || '空'}：单段只许 hygiene / status`);
      }
      if (singleReadCount > 1) {
        softFail('GA15', `这一拍有 ${singleReadCount} 格单段读，全拍只许一格`);
      }
      if (step2Change) {
        softFail('GA15', '单段读候选不许写 step2（第二步是动的意思，这一格只读）');
      }
      if (!String(plan?.idea ?? '').trim()) {
        softFail('GA15', '单段读的产出是「读了什么、看到什么」，idea 不许空');
      }
      if (steps.length === 0) {
        softFail('GA15', '单段读也要写 plan.steps（至少那一步只读的原语）');
      }
      const howtoCheck = checkUndoHowto(String(intent?.undo?.howto ?? ''));
      if (!howtoCheck.ok) {
        softFail('GA15', `单段读也要写复核方式（undo.howto 写「只读，无改动」+ 怎么核实的）：${howtoCheck.problems.join('；')}`);
      }
    } else {
      // 两步齐全：读完接着动
      if (!step2) {
        softFail('GA15', 'step1.verdict=continue 但没写 step2：读了要动，第二步得写清动什么');
      } else if (!step2Change) {
        softFail('GA15', 'step2.change 是空的（一句话说动什么、动哪儿）');
      }
      const planPrimitives = steps.map((step) => parseStep(step, mainObjectKind || objectKind))
        .filter(Boolean)
        .map((parsed) => parsed.primitive);
      if (mainPrimitive && !planPrimitives.includes(mainPrimitive)) {
        softFail('GA15', `plan.steps 里没有动作那一步：候选 ${candidate.id} 的 A 是 ${mainPrimitive}，steps 里得出现它`);
      }
    }

    /*
     * ── GA16：第一步必须是只读原语 ──
     * 候选那一栏直接读 cells.read.primitive（grid 的 ROLE_READ 口径），模型在 step1.read
     * 里自述的文字只进日志、不参与判断。另外核 plan.steps[0] 不是 P2~P7：
     * 读排在动前面是规则第二节的硬结构，不是建议。
     */
    const readPrimitive = String(cells.read?.primitive ?? '').trim();
    if (!READONLY_PRIMITIVES.has(readPrimitive)) {
      softFail('GA16', `候选 ${candidate.id} 的读格原语是 ${readPrimitive || '空'}，不是只读原语（只许 inspect / external-research）`);
    }
    const firstStep = parseStep(steps[0] ?? '', mainObjectKind || objectKind);
    if (firstStep && ACTION_PRIMITIVES.has(firstStep.primitive)) {
      softFail('GA16', `plan.steps 的第一步是动作原语（${firstStep.primitive}）：读的那一步要排在动前面`);
    }
  }

  /*
   * ── GA17：素材有没有文件锚点，方案第一步落在哪 ──
   * 代码只判硬的一半：素材正文里认不认得出带扩展名的文件路径。认不出（纯方向描述）
   * 和认出了（锚点是哪几个文件）都只把事实交给 arbiter；「第一步是不是真冲着那处去」
   * 是合理性判断，gate 不猜。
   */
  if (candidate) {
    const matPaths = materialFilePaths(candidate.material);
    const pointers = [
      `step1.read=${String(plan?.step1?.read ?? '').trim() || '（空）'}`,
      `object.value=${objectValue || '（空）'}`,
      `anchor=${anchor || '（空）'}`,
      `plan.files=${files.join('、') || '（空）'}`,
    ].join('；');
    unsure.push({
      ga: 'GA17',
      why: matPaths.length === 0
        ? '素材里没有可认的文件锚点（只有方向描述）：第一步的对象与素材是否一致，代码判不了'
        : `素材里有文件锚点 ${matPaths.join('、')}：第一步是不是同一处，代码判不了`,
      subject: `素材=${String(candidate.material ?? '').trim() || '（空）'}；${pointers}`,
    });
  }

  return {
    ok: reject.length === 0,
    allowDo: reject.length === 0 && downgrade.length === 0,
    reject,
    downgrade,
    unsupported,
    unsure,
    notes,
    hits: [...hits],
    checks,
  };
}

/**
 * GA7 的撤回模板例子：一张表，两处用——降级文案里给一条能照抄的例子，
 * 重写提示词的「逐条怎么改」也从这个表取（undoHintForPlan）。别在 proposer 里另抄一份。
 */
export const UNDO_TEMPLATE_HINTS = Object.freeze({
  'edit-file': 'git checkout -- lib/xxx.js',
  'edit-config': 'cp ~/.dsh/x.yml ~/.dsh/x.yml.bak && 改回原键',
  service: 'systemctl start xxx',
  'memory-write': '把该条改写回旧值',
  delete: 'cp 到备份目录再从备份拷回',
  draft: 'rm ~/fatfish/plans/backlog-<编号>.md',
});

/** GA7 降级文案里给一条能照抄的模板例子 */
export function undoTemplateHint(primitive) {
  return UNDO_TEMPLATE_HINTS[primitive] ?? '写一条能直接跑的撤回命令';
}

/**
 * 重写提示词的 GA7 修法要用的「动作类型 + 模板原文」。
 * 先按 GA7 自己的口径认原语：pick 那格的候选动作（跟在 gate 里判 GA7 用的是同一个 mainCell），
 * 认不出再看方案自己的 plan.steps（`P3×config` 那一段）。模板原文走 undoTemplateHint，
 * 提示词那边不另写一份模板表。
 * 曾经有一拍 plan_steps 是 0、候选 C01 的动作格是 edit-config：
 * 只看 steps 会认不出动作类型，所以候选优先。
 * 两处都认不出返回 null，调用方退回一句通用说法，不去猜。
 * @param {object|null} plan parseStage2Plan 的 plan
 * @param {Array<object>} [candidates] 这一拍的候选表（index 传进来的那份）
 * @returns {{primitive: string, hint: string}|null}
 */
export function undoHintForPlan(plan, candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  const candidate = list.find((one) => String(one?.id ?? '') === String(plan?.pick ?? '').trim()) ?? null;
  const fromCandidate = String(mainCellOf(candidateCells(candidate))?.primitive ?? '').trim();
  if (fromCandidate && UNDO_TEMPLATES[fromCandidate]) {
    return { primitive: fromCandidate, hint: undoTemplateHint(fromCandidate) };
  }
  const steps = Array.isArray(plan?.plan?.steps) ? plan.plan.steps : [];
  const fallbackObject = String(plan?.object?.kind ?? '').trim();
  for (const step of steps) {
    const parsed = parseStep(step, fallbackObject);
    if (!parsed || !UNDO_TEMPLATES[parsed.primitive]) continue;
    return { primitive: parsed.primitive, hint: undoTemplateHint(parsed.primitive) };
  }
  return null;
}

/**
 * 解析提议器的回复（原 proposer.js:87）。
 * idea 为空串是合法结果（= 今天没话说）；字段缺失、不是 JSON、idea 没写清对象/数量一律 null（当这一拍失败）。
 * @param {string} text
 * @param {{objectHints?: string[]}} [options]
 * @returns {{idea: string, why: string}|null}
 */
export function parseProposal(text, { objectHints } = {}) {
  const value = extractJson(text);
  if (!value) return null;
  if (typeof value.idea !== 'string' || typeof value.why !== 'string') return null;
  const idea = value.idea.trim();
  const why = value.why.trim();
  if (!validateIdea(idea, { objectHints }).ok) return null;
  return { idea, why };
}

/* ══ ③ Gate·LLM 裁决：终审回复 ══════════════════════════════════════ */

/** dispatch_open 的 brief 上限（列宽）：一个汉字算 2 列 */
export const BRIEF_MAX_COLUMNS = 34;

export const ACTIONS = ['silent', 'ask', 'do', 'rewrite'];

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
 * ask 文案里数字的出处集合：点子、理由，再加整份方案里显式写过的文本。
 *
 * 为什么不能只看 idea/why：曾经有一拍 ask 文案复述「.5/.6/.7」——
 * 这三个数字是方案自己 step2.files / 第一轮 idea 里写过的文件名尾巴，不是编的，
 * 但 idea/why 里只剩「7 份」，5、6 就被判成「自己加了点子/理由里没有的数字」，
 * 整条裁决作废，这一拍白跑。数字有出处就该放行，出处包括方案里的每个字符串字段。
 *
 * 抽数字只遮日期/时刻（numbersIn + maskDatesAndTimes）：
 * 文案里「11-08」和理由里的「2026-11-08」是同一个日期坐标的不同写法，不该因为写法
 * 不同判成编造；数字是逐字面比的，不做量纲或大小的筛选。
 * @param {{idea?: string, why?: string, plan?: object, sources?: Array<unknown>}} [evidence]
 * @returns {Set<string>}
 */
export function askNumberSources({ idea = '', why = '', plan = null, sources = [] } = {}) {
  const texts = [String(idea ?? ''), String(why ?? '')];
  const collect = (value, depth = 0) => {
    if (value == null || depth > 4) return;
    if (typeof value === 'string') {
      texts.push(value);
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      texts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const one of value) collect(one, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const one of Object.values(value)) collect(one, depth + 1);
    }
  };
  collect(plan);
  for (const one of Array.isArray(sources) ? sources : []) collect(one);
  const set = new Set();
  for (const text of texts) for (const n of numbersIn(maskDatesAndTimes(text))) set.add(n);
  return set;
}

/**
 * 查 ask 文案够不够格发到用户那边（原 judge.js:87）。
 * @param {string} text
 * @param {{idea?: string, why?: string, plan?: object, sources?: Array<unknown>,
 *   rules?: {minChars?: number, maxChars?: number, forbidden?: string[]}}} [evidence]
 *   点子、理由、整份方案：文案里的数字要从这些地方找得到出处；rules 覆盖默认长度与禁词（配置项 `judge.*`）
 * @returns {{ok: boolean, problems: string[], warnings: string[], len: number}}
 */
export function validateAskText(text, { idea = '', why = '', plan = null, sources = [], rules = {} } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, problems: ['ask 文案是空的'], warnings: [], len: 0 };

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

  /*
   * 数字出处只在「有出处可查」时比对，而且命中不算文案不合格：文案是用户唯一看到的一句，
   * 数字对不上属于「该记一笔」，不该让整条裁决作废（作废 = 这一拍连问都没问出去）。
   * 出处包括点子、理由、整份方案（step1.read / step2.files / evidence[].value / object）。
   */
  const warnings = [];
  const known = askNumberSources({ idea, why, plan, sources });
  if (known.size > 0) {
    const extra = [...new Set(numbersIn(maskDatesAndTimes(raw)).filter((n) => !known.has(n)))];
    if (extra.length > 0) {
      warnings.push(`ask 文案里的数字 ${extra.join('、')} 在点子/理由/方案里找不到出处（只记日志，不拦这一拍）`);
    }
  }

  const hasIdentifier = /[A-Za-z][A-Za-z0-9_.\-/]{2,}/.test(raw);
  const hasObjectNoun = ASK_OBJECT_HINTS.some((word) => raw.includes(word));
  if (!hasIdentifier && !hasObjectNoun) {
    problems.push('没写清对象（表名 / 路径 / 服务 / 文件）');
  }

  return { ok: problems.length === 0, problems, warnings, len };
}

/* ══ ③.5 intent 契约：撤回账本要的那一栏 ════════════════════════════ */

/**
 * 可撤回性三档（dispatcher 的撤回账本按这个分闸）：
 *   auto   能自己撤回来（重跑一遍、删掉重生成、git 里捞回来）
 *   manual 要人工按 undo.howto 动手撤，所以 impact 不许全空
 *   none   撤不回来（push、发消息、删不可恢复的东西）→ 这一档不许出 do
 */
export const REVERSIBILITY = ['auto', 'manual', 'none'];

/** undo.howto 的字符下限：一条真命令没这么短 */
export const UNDO_MIN_CHARS = 10;

/** undo.howto 的空话词：命中就说明写的是态度不是命令。挡常见的敷衍写法，够不够跑由执行方核 */
export const UNDO_EMPTY_TALK = [
  '整理一下',
  '检查一下',
  '看一下',
  '处理一下',
  '清理一下',
  '调整一下',
  '改一下',
  '修一下',
  '手动处理',
  '手动修',
  '看情况',
  '视情况',
  '酌情',
  '适当',
  '按需',
  '稍后',
  '再说',
  '自己判断',
  '具体问题具体分析',
  '待定',
];

const cleanStrings = (value) =>
  Array.isArray(value) ? value.map((one) => String(one ?? '').trim()).filter(Boolean) : [];

/** impact 三项全空？manual 档靠这个判有没有依据 */
export function impactIsEmpty(impact) {
  return cleanStrings(impact?.paths).length === 0
    && cleanStrings(impact?.services).length === 0
    && cleanStrings(impact?.remotes).length === 0;
}

/**
 * 把终审给的 intent 规整成固定形状；不是对象就返回 null（= 没写）。
 * 缺字段不抛：reversibility 认不出的留空串，由 checkIntentContract 按 none 处理。
 */
export function normalizeIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null;
  const rev = String(intent.reversibility ?? '').trim().toLowerCase();
  const dry = intent.dryRun && typeof intent.dryRun === 'object' ? intent.dryRun : {};
  const undo = intent.undo && typeof intent.undo === 'object' ? intent.undo : {};
  return {
    impact: {
      paths: cleanStrings(intent?.impact?.paths),
      services: cleanStrings(intent?.impact?.services),
      remotes: cleanStrings(intent?.impact?.remotes),
    },
    reversibility: REVERSIBILITY.includes(rev) ? rev : '',
    dryRun: { ok: dry.ok === true, detail: String(dry.detail ?? '').trim() },
    undo: {
      kind: String(undo.kind ?? '').trim(),
      ref: String(undo.ref ?? '').trim(),
      howto: String(undo.howto ?? '').trim(),
    },
  };
}

/**
 * undo.howto 是不是空话：太短、命中空话词、只有一个省略号，都算没写。
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkUndoHowto(howto) {
  const raw = String(howto ?? '').trim();
  const problems = [];
  if (!raw) {
    problems.push('do 的 undo.howto 是空的（要一句话写清撤回命令）');
    return { ok: false, problems };
  }
  if (charLength(raw) < UNDO_MIN_CHARS) {
    problems.push(`undo.howto 只有 ${charLength(raw)} 个字符，写不出一条具体命令`);
    return { ok: false, problems };
  }
  const hit = UNDO_EMPTY_TALK.find((word) => raw.includes(word));
  if (hit) problems.push(`undo.howto 是空话（命中「${hit}」），要写具体命令`);
  // 「……」「...」「—」这类：没字母数字就等于没写命令
  if (!/[A-Za-z0-9]/.test(raw)) problems.push('undo.howto 里没有任何命令，只有标点或省略号');
  return { ok: problems.length === 0, problems };
}

/**
 * do 的 intent 契约硬校验（G2 那几条里「直接拒」的部分）。
 * 降级（none + do → ask）不在这里做，见 settleDecision——它要改 decision，属于路由前一步。
 *
 * @param {object|null} intent normalizeIntent 的结果
 * @returns {string[]} 空数组 = 过
 */
export function checkIntentContract(intent) {
  if (!intent) return []; // 没写 intent：灰度期只放行，缺字段要不要按 none 由 intentRequired 决定
  const problems = [];
  if (intent.reversibility === 'manual' && impactIsEmpty(intent.impact)) {
    problems.push('reversibility=manual 但 impact 的 paths/services/remotes 三项全空，没有撤回依据');
  }
  const howto = checkUndoHowto(intent.undo.howto);
  if (!howto.ok) problems.push(...howto.problems);
  return problems;
}

/** 对外发的 ask 文案：超过 ASK_MAX_CHARS（160）就截到 150 个字符再补「…」（跟别处问话同一口径） */
export const ASK_TEXT_HEAD_CHARS = 150;

/**
 * ask 文案的长度收口。校验（validateAskText）管的是模型写的那句，
 * 这里管的是代码自己拼的那句——goal 回退成 plan 原文后能上千字，
 * 不截就会把整条 plan 塞进一条消息（用户读不完，日志也没法看）。
 *
 * @param {string} text
 * @param {{max?: number, head?: number}} [options] 默认 160 / 150
 * @returns {string} 不超限原样返回（只 trim），超了 head 个字符 + 「…」
 */
export function clampAskText(text, { max = ASK_MAX_CHARS, head = ASK_TEXT_HEAD_CHARS } = {}) {
  const raw = String(text ?? '').trim();
  const all = [...raw];
  const limit = Number(max) > 0 ? Number(max) : ASK_MAX_CHARS;
  const keep = Number(head) > 0 ? Number(head) : ASK_TEXT_HEAD_CHARS;
  if (all.length <= limit) return raw;
  return `${all.slice(0, keep).join('')}…`;
}

/** 降级成 ask 时那句话的原文（goal 回退成 plan 原文后能上千字，这里先不收口） */
function downgradeAskRaw(ticket) {
  const body = String(ticket?.goal ?? '').trim() || String(ticket?.brief ?? '').trim() || '这件事';
  return `${body} —— 这一步撤不回来（reversibility=none），要开票吗？`;
}

/** 降级成 ask 时说的那句话：拿票面本身当对象，别硬编；长度在这里收口 */
export function downgradeAskText(ticket) {
  return clampAskText(downgradeAskRaw(ticket));
}

/**
 * 路由前的最后一道：none 档的 do 就地改写成 ask，别靠 openTicket 返回 false
 * （那会记一次失败、连涨 failStreak，等于用惩罚代替判断）。
 *
 * @param {object} decision parseDecisionReport 出来的裁决
 * @param {{intentRequired?: boolean}} [options] intentRequired=true 时缺 intent 也按 none 处理
 * @returns {{decision: object, notes: string[], downgraded: boolean, askTextLen?: number}}
 *   askTextLen 是收口前的原文长度（字符数），给日志记 `ask_text_len:<N>` 用，正文不进日志
 */
export function settleDecision(decision, { intentRequired = false } = {}) {
  if (!decision || decision.action !== 'do') return { decision, notes: [], downgraded: false };
  const intent = decision.ticket?.intent ?? null;
  const rev = intent ? intent.reversibility || 'none' : intentRequired ? 'none' : '';
  if (rev !== 'none') return { decision, notes: [], downgraded: false };
  const note = intent
    ? 'intent.reversibility=none，do 不许出，已降级成 ask'
    : 'intent 缺失且 intentRequired=true，按 none 处理，do 已降级成 ask';
  const raw = String(decision.text ?? '').trim() || downgradeAskRaw(decision.ticket);
  // 最后再收一次口：goal 回退成 plan 原文时 raw 能很长，对外只发 150 +「…」
  const text = clampAskText(raw);
  const reason = [String(decision.reason ?? '').trim(), note].filter(Boolean).join('｜');
  return {
    decision: { action: 'ask', text, ticket: null, reason, downgradedFrom: 'do' },
    notes: [note],
    downgraded: true,
    askTextLen: charLength(raw),
  };
}

/* ══ ③.5 goal 回写校验：路径和行号只能来自 plan 原文 ══════════════════ */

/**
 * 起因：曾经有一拍，plan 的 step1.read 写的是 `lib/gate.js:610-612`，
 * 终审写 goal 时改成了 `610-615`——多了 3 行，票面凭空长出来。
 * 终审只拿到 idea/why 时没依据核对，只能自己编，所以在开票之前补两道硬校验：
 *   ① 路径：goal 里出现的绝对路径必须是 plan 的 step2.files / object.value / step1.read 的后缀；
 *   ② 行号区间：goal 里每个「数字-数字」的两个数都得在 plan 原文里找得到。
 * 对不上就不采用终审的 goal，回退成 plan 的 idea + why 直接拼（纯字符串，不叫模型）。
 */

/**
 * goal 里的绝对路径：至少两段，允许带扩展名。
 * `~/fatfish/docs/x.md`、`/etc/nginx/conf.d/a.conf` 认；
 * 裸 `/` 和 `610-615` 不认。前面紧挨着字母/点/斜杠的不认（别把 `a/b` 的尾巴当地址）。
 */
export const GOAL_PATH_PATTERN = /(?<![\w.~/-])(\/(?:[\w.@+~-]+\/)+[\w.@+~-]*(?:\.[A-Za-z0-9]+)?)/g;

/**
 * goal 里的「数字-数字」区间：`610-615`、`42-46 行`、`:610-615`。
 * 只认区间，单个数字（「3 条」「42 秒」）不校验，否则误伤太多。
 * 日期/时刻在抽取前先遮掉（`2026-11-11`、`11-08`、`16:18` 不是行号区间）。
 */
export const GOAL_RANGE_PATTERN = /(?<![\d.])(\d{1,4})\s*[-–~]\s*(\d{1,4})(?![\d.])/g;

/**
 * 把日期和时刻遮成空格（`2026-11-11`/`11-08`/`16:18`）。
 * 原先是 ideaNumbersIn 里的三步 replace，抽出来给行号区间校验共用，行为一点没改。
 */
export function maskDatesAndTimes(text) {
  return String(text ?? '')
    // 2026-11-10 / 2026/11/10（后头紧跟 T 也认）
    .replace(/(?<!\d)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?!\d)/g, (m) => ' '.repeat(m.length))
    // 11-10：月日都在合法区间才算日期
    .replace(/(?<![\d.])\d{1,2}-\d{1,2}(?![\d.])/g, (m) => {
      const [month, day] = m.split('-').map(Number);
      return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? ' '.repeat(m.length) : m;
    })
    // 16:18 / 16:18:01：时分秒都在合法区间才算时刻（`lib/gate.js:718` 前面是冒号，不认）
    .replace(/(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g, (m) => {
      const [hour, minute, second] = m.split(':').map(Number);
      const valid = hour <= 23 && minute <= 59 && (second === undefined || second <= 59);
      return valid ? ' '.repeat(m.length) : m;
    });
}

/** 把路径尾巴的斜杠去掉；空串原样返回 */
const trimSlash = (text) => String(text ?? '').replace(/\/+$/, '');

/** 证据串的两种形态：原文，和去掉 `:36-70` 行号后缀的纯路径 */
function pathForms(value) {
  const raw = trimSlash(String(value ?? '').trim());
  if (!raw) return [];
  const out = [raw];
  const bare = trimSlash(raw.replace(/:\d+(?:-\d+)?$/, ''));
  if (bare && bare !== raw) out.push(bare);
  return out;
}

/**
 * plan 里能当「路径出处」的字段：step2.files / plan.files 的每一条、object.value、step1.read。
 * 每条同时留「原文」和「去掉行号后缀」两种形态，好让 goal 写短、写全都能对上。
 */
export function goalPathEvidence(plan = {}) {
  const out = new Set();
  const add = (value) => {
    for (const one of pathForms(value)) out.add(one);
  };
  for (const list of [plan?.step2?.files, plan?.plan?.files]) {
    if (Array.isArray(list)) for (const one of list) add(one);
  }
  add(plan?.object?.value);
  add(plan?.step1?.read);
  return [...out];
}

/**
 * 行号区间校验用的 plan 大字符串：idea / why / step1.read / step2.change / step2.undo / step2.files。
 * 数字只在这个串里找，找不到就判回退。
 */
export function goalLineBlob(plan = {}) {
  const files = Array.isArray(plan?.step2?.files) ? plan.step2.files : [];
  return [
    plan?.idea,
    plan?.why,
    plan?.step1?.read,
    plan?.step2?.change,
    plan?.step2?.undo,
    ...files,
  ]
    .map((one) => String(one ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * goal 里的绝对路径。`~/x` 先按 home 展开；没给 home 就当不是绝对路径，不校验（不误伤）。
 * @returns {string[]} 去重后的路径，末尾斜杠已去掉
 */
export function goalPaths(goal, { home = process.env.HOME || '' } = {}) {
  let text = String(goal ?? '');
  if (home) text = text.replace(/(^|[\s（(「『"'，,、：:；;])~\//g, `$1${trimSlash(home)}/`);
  const out = new Set();
  for (const match of text.matchAll(GOAL_PATH_PATTERN)) {
    const one = trimSlash(match[1]);
    if (one) out.add(one);
  }
  return [...out];
}

/**
 * goal 里的「数字-数字」区间（日期/时刻已遮掉）。
 * @returns {Array<{text: string, from: number, to: number}>}
 */
export function goalLineRanges(goal) {
  const masked = maskDatesAndTimes(goal);
  const out = [];
  for (const match of masked.matchAll(GOAL_RANGE_PATTERN)) {
    out.push({ text: match[0].trim(), from: Number(match[1]), to: Number(match[2]) });
  }
  return out;
}

/**
 * 这条路径算不算「plan 里出现过」：互相是后缀就算（允许 goal 写短 `docs/x.md`，
 * 也允许 plan 写短、goal 写全 `~/fatfish/docs/x.md`）。编出来的路径对不上任何一条。
 */
export function pathHitsEvidence(path, evidence) {
  const needle = trimSlash(path);
  if (!needle) return false;
  const needleBare = needle.replace(/^\/+/, '');
  for (const raw of evidence ?? []) {
    const hay = trimSlash(raw);
    if (!hay) continue;
    if (hay === needle) return true;
    if (hay.endsWith(needle) || hay.endsWith(`/${needleBare}`)) return true;
    const hayBare = hay.replace(/^\/+/, '');
    if (hayBare.endsWith(needleBare) || needleBare.endsWith(hayBare)) return true;
    if (needle.endsWith(hay) && hay.includes('/')) return true;
  }
  return false;
}

/** plan 大字符串里有没有这个数（按数字边界找，`615` 不会在 `1615` 里命中） */
export function numberInPlanBlob(blob, number) {
  const n = Number(number);
  if (!Number.isFinite(n)) return false;
  return new RegExp(`(?<!\\d)${n}(?!\\d)`).test(String(blob ?? ''));
}

/** 回退时拼的 goal：idea + 换行 + why；why 空就只用 idea */
export function fallbackGoal(plan = {}) {
  const idea = String(plan?.idea ?? '').trim();
  const why = String(plan?.why ?? '').trim();
  if (!idea) return why;
  return why ? `${idea}\n${why}` : idea;
}

/**
 * 开票前的最后一道：终审的 goal 里如果出现 plan 没有的路径 / 行号区间，整条 goal 不采用，
 * 换成 plan 原文拼的 goal。brief 照原来的口径（非空照旧截 34 列，空就用新 goal 兜底）。
 *
 * @param {object} decision parseDecisionReport 出来的裁决（只处理 action=do）
 * @param {object} plan stage2 的方案原文
 * @param {{log?: (line: string) => void, briefMaxColumns?: number, home?: string}} [options]
 * @returns {{decision: object, fallback: boolean, codes: string[]}}
 *   codes 里是 `goal_path_mismatch:路径:<path>` / `goal_line_mismatch:区间:<a-b>`
 */
export function guardGoal(decision, plan = {}, options = {}) {
  const write = typeof options.log === 'function' ? options.log : () => {};
  if (!decision || decision.action !== 'do' || !decision.ticket) {
    return { decision, fallback: false, codes: [] };
  }
  const goal = String(decision.ticket.goal ?? '');
  const codes = [];

  const evidence = goalPathEvidence(plan);
  const badPath = goalPaths(goal, { home: options.home }).find((one) => !pathHitsEvidence(one, evidence));
  if (badPath) codes.push(`goal_path_mismatch:路径:${badPath}`);

  const blob = goalLineBlob(plan);
  const badRange = goalLineRanges(goal).find(
    (one) => !numberInPlanBlob(blob, one.from) || !numberInPlanBlob(blob, one.to),
  );
  if (badRange) codes.push(`goal_line_mismatch:区间:${badRange.text}`);

  if (codes.length === 0) return { decision, fallback: false, codes };

  const nextGoal = fallbackGoal(plan);
  if (!nextGoal) {
    // plan 里连 idea 都没有，拼不出回退 goal：只记一笔，照旧用终审的 goal
    write(`${codes.join('｜')}｜plan 里没有 idea/why，拼不出回退 goal，仍用终审的 goal`);
    return { decision, fallback: false, codes };
  }
  const limit = Number(options.briefMaxColumns) > 0 ? Number(options.briefMaxColumns) : BRIEF_MAX_COLUMNS;
  const brief = truncateColumns(String(decision.ticket.brief ?? '').trim() || nextGoal, limit);
  write(`${codes.join('｜')}｜已回退成 plan 原文拼 goal`);
  return {
    decision: { ...decision, ticket: { ...decision.ticket, goal: nextGoal, brief } },
    fallback: true,
    codes,
  };
}

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

/**
 * 解析终审的回复，并带回「为什么没过」（原 judge.js:264）。
 *
 * 校验吃的永远是 runAgent 给的完整文本（`assistantText` 不裁剪，`extractJson` 全文扫），
 * 曾经有一拍回复完整闭合，被拦是因为 ask 文案超了当时的上限——日志里看着断在 160 字
 * 只是显示时截的。所以这个函数必须分开报：
 *   · JSON 没闭合 → 模型输出真被截断（finish=max-tokens 或写到一半停了）；
 *   · JSON 闭合但 ask 文案不合格 → 校验拦的，问题在文案不在截断。
 *
 * @param {string} text
 * @param {{idea?: string, why?: string, rules?: object, briefMaxColumns?: number}} [evidence]
 *   传入后，ask 文案里的数字必须来自点子和理由；briefMaxColumns 覆盖 brief 列宽（默认 34）
 * @returns {{ok: boolean, decision: {action: 'silent'|'ask'|'do', text: string, ticket: {goal: string, brief: string}|null, reason: string}|null, problems: string[], len: number, text: string, scope?: 'reply'|'ask'}}
 *          scope='ask' 时 len/text 说的是 ask 文案本身（不是整段 JSON）
 */
export function parseDecisionReport(text, evidence = {}) {
  const raw = String(text ?? '');
  const len = charLength(raw);
  const fail = (...problems) => ({ ok: false, decision: null, problems, warnings: [], len, text: raw, scope: 'reply' });

  const jsonMeta = {};
  const value = extractJson(raw, jsonMeta);
  if (jsonMeta.repaired) {
    (typeof evidence.log === 'function' ? evidence.log : logJsonRepair)('json_repaired:1｜补了末尾 1 个 }');
  }
  if (!value) {
    // 分两种：有 { 但没配平 = 写到一半断了；连 { 都没有 = 模型压根没按格式答
    if (raw.includes('{')) return fail('回复里的 JSON 没闭合（写到一半被截断，或后面的字把 } 吞了）');
    return fail('回复里没有 JSON 对象');
  }
  const action = typeof value.action === 'string' ? value.action.trim().toLowerCase() : '';
  if (!ACTIONS.includes(action)) {
    return fail(`action 非法：${JSON.stringify(value.action ?? null)}（只能 silent / ask / do / rewrite）`);
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (action === 'silent') return { ok: true, decision: { action, text: '', ticket: null, reason }, problems: [], warnings: [], len, text: raw };
  if (action === 'rewrite') {
    // rewrite 的 reason 会原样喂回 stage2，空着等于打回不说理由，这一拍只能作废
    if (!reason) return fail('action=rewrite 但 reason 是空的（要写清要改什么）');
    return { ok: true, decision: { action, text: '', ticket: null, reason }, problems: [], warnings: [], len, text: raw };
  }
  if (action === 'ask') {
    const said = typeof value.text === 'string' ? value.text.trim() : '';
    if (!said) return fail('action=ask 但 text 是空的');
    // 长度/禁词/问句/对象不合格就整拍失败：宁可这一拍不说，也不把用户看不懂的话发出去。
    // 数字出处不在此列（更早那版把它算成致命，5、6 一次误判就白跑一拍）。
    const checked = validateAskText(said, evidence);
    if (!checked.ok) {
      return { ok: false, decision: null, problems: checked.problems, warnings: checked.warnings, len: checked.len, text: said, scope: 'ask' };
    }
    // 数字对不上出处只当警告带走，不拦整条裁决：这一拍仍按 ask 走，index.js 记一行 ask_number_warn
    return { ok: true, decision: { action, text: said, ticket: null, reason }, problems: [], warnings: checked.warnings, len, text: raw };
  }
  const goal = typeof value.ticket?.goal === 'string' ? value.ticket.goal.trim() : '';
  if (!goal) return fail('action=do 但 ticket.goal 是空的');
  // intent 契约：manual 空 impact、空话 howto 直接拒。none + do 不在这里拒——
  // 那是要改 decision 的动作（降级成 ask），在 settleDecision 里做。
  const intent = normalizeIntent(value.ticket?.intent);
  const intentProblems = checkIntentContract(intent);
  if (intentProblems.length > 0) {
    return { ok: false, decision: null, problems: intentProblems, warnings: [], len, text: raw, scope: 'intent' };
  }
  const briefRaw = typeof value.ticket?.brief === 'string' ? value.ticket.brief.trim() : '';
  const briefLimit = Number(evidence?.briefMaxColumns) > 0 ? Number(evidence.briefMaxColumns) : BRIEF_MAX_COLUMNS;
  // brief 空就拿 goal 兜底：dispatch_open 要求非空，而列宽只有 34
  const brief = truncateColumns(briefRaw || goal, briefLimit);
  return { ok: true, decision: { action, text: '', ticket: { goal, brief, intent }, reason }, problems: [], warnings: [], len, text: raw };
}

/* ══ Gate 对象：把上面两层绑成一份可配的校验器 ══════════════════════ */

const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

/**
 * 建一个 Gate。规则一拍内不变，所以 index.js 在 apply 时建一次就够。
 *
 * 缺省全用现有默认值：空对象名词表、60~160 字符、ASK_FORBIDDEN 那 10 个禁词、brief 34 列。
 * 调用时传的 rules 仍然逐项覆盖构造参数（跟原来 validateAskText 的覆盖规则一样：
 * 只有 >0 的长度、非空的禁词数组才算数），保持行为等价。
 *
 * `intentRequired` 默认 false（灰度）：false 时缺 intent 的 do 照旧放行，
 * 老格式行为一点不变；true 时缺 intent 的 do 按 reversibility=none 处理（降级成 ask）。
 *
 * `deps` 是 GA3/GA4/GA5 要用的「读盘那两下」：gate 自己不 import fs/path/os，
 * 真实现（lib/exists.js 的 checkExists / checkFileLine）由 index.js 在 apply 时注入，
 * 单测传 stub。没注入时那几条按 unsupported 处理，不按「不合格」拒。
 *
 * `outboundTargets` 是 GA14 的白名单（配置项 `outboundTargets`）：checkPlan 的
 * `opts.outboundTargets` 优先，没传就用构造时这份；两处都没有就是空表 = 一律不许发。
 *
 * @param {{
 *   objectHints?: string[],
 *   ask?: {minChars?: number, maxChars?: number, forbidden?: string[]},
 *   briefMaxColumns?: number,
 *   intentRequired?: boolean,
 *   outboundTargets?: string[],
 *   deps?: {
 *     checkExists?: (object: {kind: string, value: string}) => Promise<object>,
 *     checkFileLine?: (anchor: string) => Promise<object>,
 *   },
 * }} [options]
 *   objectHints ← `proposer.objectHints`；ask.* ← `judge.askMinChars` / `askMaxChars` / `forbiddenWords`
 * @returns {{
 *   checkProposal: (text: string, opts?: {objectHints?: string[]}) => {idea: string, why: string}|null,
 *   checkPlan: (plan: object, opts?: object) => Promise<object>,
 *   checkDecision: (text: string, evidence?: object) => object,
 *   settle: (decision: object) => {decision: object, notes: string[], downgraded: boolean},
 *   rules: {minChars: number, maxChars: number, forbidden: string[]},
 *   objectHints: string[]|undefined,
 *   briefMaxColumns: number,
 *   intentRequired: boolean,
 *   outboundTargets: string[],
 *   deps: object,
 * }}
 */
export function createGate(options = {}) {
  const {
    objectHints, ask = {}, briefMaxColumns = BRIEF_MAX_COLUMNS, intentRequired = false,
    outboundTargets = [], deps = {},
  } = options ?? {};
  const rules = {
    minChars: positive(ask?.minChars, ASK_MIN_CHARS),
    maxChars: positive(ask?.maxChars, ASK_MAX_CHARS),
    forbidden: Array.isArray(ask?.forbidden) && ask.forbidden.length > 0 ? ask.forbidden.map(String) : ASK_FORBIDDEN,
  };
  const hintList = Array.isArray(objectHints) ? objectHints : undefined;
  const briefLimit = positive(briefMaxColumns, BRIEF_MAX_COLUMNS);
  const gateDeps = deps && typeof deps === 'object' ? deps : {};
  // GA14 的白名单：构造时归一一次，checkPlan 的 opts 给了就以那次为准
  const outboundList = normalizeOutboundTargets(outboundTargets);

  /** ② 代码规则这一层：调用级 objectHints 优先，否则用构造时那份（再缺就回到默认空表） */
  function checkProposal(text, opts = {}) {
    return parseProposal(text, { objectHints: opts?.objectHints ?? hintList });
  }

  /**
   * ②.5 stage2 方案这一层：先跑纯函数 checkStage2Plan，再把 GA3/GA4/GA5 的待核查项
   * 交给注入的 deps 去读盘。`opts.deps` 可以覆盖构造时那份（单测传 stub 用）。
   *
   * 返回形状跟 checkStage2Plan 一样，外加：
   *   ok       拒项为空（这一拍还能不能往下走）
   *   allowDo  拒项与降级项都为空（这一拍许不许出 do）
   *   hits     命中过的 GA 编号（含 deps 追加的），日志 ga_hits 用
   *
   * @param {object} plan parseStage2Plan 的 plan
   * @param {object} [opts] checkStage2Plan 的 context，另认 deps
   * @returns {Promise<object>}
   */
  async function checkPlan(plan, opts = {}) {
    const localDeps = { ...gateDeps, ...(opts?.deps ?? {}) };
    const verdict = checkStage2Plan(plan, {
      ...(opts ?? {}),
      // GA14 白名单：调用级优先，没给就用构造时那份（都没有 = 空表）
      outboundTargets: opts && Object.prototype.hasOwnProperty.call(opts, 'outboundTargets')
        ? normalizeOutboundTargets(opts.outboundTargets)
        : outboundList,
    });
    const reject = [...verdict.reject];
    // GA3 在这一层才跑得出结果：它是可重写降级，所以单独攒一份，别混进 verdict.downgrade
    const downgrade = [...verdict.downgrade];
    const unsupported = [...verdict.unsupported];
    const hits = new Set(verdict.hits);
    /** GA3（路径不存在 / config 扩展名不对）打回重写；原本是拒，用满次数落 silent */
    const softFailGa3 = (why) => {
      downgrade.push({ ga: 'GA3', code: 'GA3', originalAction: REWRITE_GATE_ACTIONS.GA3, why });
      hits.add('GA3');
    };
    const denyRoots = Array.isArray(opts?.denyRoots) && opts.denyRoots.length > 0 ? opts.denyRoots.map(String) : [TMP_DENY_ROOT];
    const allowlist = Array.isArray(opts?.tmpAllowlist) ? opts.tmpAllowlist.map(String) : [];

    /** 路径是不是落在拒绝根里（GA5）：`/tmp` 与 `/tmp/x` 都算，`/tmpx` 不算 */
    const underDenyRoot = (resolved) => denyRoots.find((root) => {
      if (!root) return false;
      const target = String(resolved ?? '');
      if (allowlist.some((one) => one && (target === one || target.startsWith(one.endsWith('/') ? one : `${one}/`)))) return false;
      const base = root.endsWith('/') ? root.slice(0, -1) : root;
      return target === base || target.startsWith(`${base}/`);
    });

    // GA3 / GA5 共用一次核查：同一对象查两遍没意义
    const objects = new Map();
    for (const check of verdict.checks) {
      if (check.ga === 'GA3' || check.ga === 'GA5') objects.set(`${check.kind}|${check.value}`, check);
    }
    for (const check of objects.values()) {
      if (typeof localDeps.checkExists !== 'function') {
        unsupported.push({ ga: 'GA3', why: '没注入 checkExists（读盘那一半不在 gate 里），对象存在性这一拍没核' });
        continue;
      }
      let res;
      try {
        res = await localDeps.checkExists({ kind: check.kind, value: check.value });
      } catch (error) {
        unsupported.push({ ga: 'GA3', why: `核查「${check.value}」时抛错：${String(error?.message ?? error)}，按未核处理` });
        continue;
      }
      const status = String(res?.status ?? '');
      if (status === 'ok') {
        const root = underDenyRoot(res?.path);
        if (root) {
          reject.push({ ga: 'GA5', why: `对象「${check.value}」落在 ${root} 里（realpath 后是 ${res.path}），这一批不许碰` });
          hits.add('GA5');
        }
        continue;
      }
      if (status === 'denied') {
        reject.push({ ga: 'GA5', why: `对象「${check.value}」过不了路径检查：${res?.reason || '不在允许根内'}` });
        hits.add('GA5');
        continue;
      }
      if (status === 'missing') {
        softFailGa3(`对象不存在：${check.value}（${res?.reason || '查不到'}）`);
        continue;
      }
      if (status === 'invalid') {
        softFailGa3(`对象写得不成立：${check.value}（${res?.reason || '入参不对'}）`);
        continue;
      }
      unsupported.push({ ga: 'GA3', why: `对象「${check.value}」这一类没有查询源（${res?.reason || status || '未核'}）` });
    }

    // GA4：文件:行号锚点越不越界
    for (const check of verdict.checks) {
      if (check.ga !== 'GA4') continue;
      if (typeof localDeps.checkFileLine !== 'function') {
        unsupported.push({ ga: 'GA4', why: '没注入 checkFileLine（读盘那一半不在 gate 里），锚点行号这一拍没核' });
        continue;
      }
      let res;
      try {
        res = await localDeps.checkFileLine(check.anchor);
      } catch (error) {
        unsupported.push({ ga: 'GA4', why: `核查锚点「${check.anchor}」时抛错：${String(error?.message ?? error)}，按未核处理` });
        continue;
      }
      const status = String(res?.status ?? '');
      if (status === 'ok') continue;
      if (status === 'denied') {
        reject.push({ ga: 'GA5', why: `锚点「${check.anchor}」过不了路径检查：${res?.reason || '不在允许根内'}` });
        hits.add('GA5');
        continue;
      }
      if (status === 'missing') {
        reject.push({ ga: 'GA4', why: `锚点「${check.anchor}」对不上：${res?.reason || '行号越界'}` });
        hits.add('GA4');
        continue;
      }
      if (status === 'invalid') {
        reject.push({ ga: 'GA4', why: `锚点「${check.anchor}」不成立：${res?.reason || '不是文件:行号'}` });
        hits.add('GA4');
        continue;
      }
      unsupported.push({ ga: 'GA4', why: `锚点「${check.anchor}」这一类没核（${res?.reason || status || '未核'}）` });
    }

    return {
      ...verdict,
      ok: reject.length === 0,
      allowDo: reject.length === 0 && downgrade.length === 0,
      reject,
      downgrade,
      unsupported,
      hits: [...hits],
    };
  }

  /** ③ 裁决这一层：evidence.rules 逐项覆盖构造时的规则，其余照旧（数字有据、对象、单问句） */
  function checkDecision(text, evidence = {}) {
    const given = evidence?.rules ?? {};
    const merged = {
      minChars: positive(given.minChars, rules.minChars),
      maxChars: positive(given.maxChars, rules.maxChars),
      forbidden: Array.isArray(given.forbidden) && given.forbidden.length > 0 ? given.forbidden.map(String) : rules.forbidden,
    };
    return parseDecisionReport(text, { ...(evidence ?? {}), rules: merged, briefMaxColumns: briefLimit });
  }

  /** 路由前最后一道：none 档的 do 改成 ask（改的是 decision，不是返回值） */
  function settle(decision) {
    return settleDecision(decision, { intentRequired });
  }

  return {
    checkProposal,
    checkPlan,
    checkDecision,
    settle,
    get rules() {
      return rules;
    },
    get objectHints() {
      return hintList;
    },
    get briefMaxColumns() {
      return briefLimit;
    },
    get intentRequired() {
      return Boolean(intentRequired);
    },
    get outboundTargets() {
      return outboundList;
    },
    get deps() {
      return gateDeps;
    },
  };
}
