/**
 * 配置 schema 段与兜底默认值。
 *
 * lib/index.js 只保留 name / inject / Config / apply：这里导出四段 schema
 * （ProposerSection / JudgeSection / ArbiterSection）和 DEFAULTS，Config 在入口拼。
 * 行为零改动：schema 默认值、字段顺序、注释口径都原样。
 */
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { JUDGE_TIMEOUT_MS, PROPOSER_TIMEOUT_MS } from './agent-run.js';
import {
  ARBITER_MAX_TOKENS_DEFAULT,
  JUDGE_MAX_TOKENS_DEFAULT,
  STAGE1_MAX_TOKENS_DEFAULT,
  STAGE2_MAX_TOKENS_DEFAULT,
} from './budget.js';
import { DEFAULT_MAX_REWRITE, PROPOSER_MATERIALS } from './proposer.js';
import { DEFAULT_PLANS_PATH } from './plans-log.js';
import { DEFAULT_FORCE_INTERVAL_MS, DEFAULT_FORCE_PATH } from './force.js';
import { DEFAULT_ANNOUNCE_DELAY_MS, DEFAULT_ANNOUNCE_TEMPLATE } from './announce.js';
import { DEFAULT_ANNOUNCE_RETRY_WINDOW_MS } from './announce-retry.js';
import { ASK_FORBIDDEN, ASK_MAX_CHARS, ASK_MIN_CHARS } from './judge.js';
import { ARBITER_MAX_CASES_DEFAULT, ARBITER_TIMEOUT_MS } from './arbiter.js';

const DEFAULT_PROPOSER_ALLOW = [
  'read',
  'glob',
  'grep',
  'chat_recall',
  'memory_recall',
  'memory_entity',
  'sbi_search',
  'sbi_status',
  'web_search',
  'web_fetch',
  'host_status',
  'host_alerts',
  'read_image',
];

const DEFAULT_JUDGE_ALLOW = ['read', 'chat_recall', 'memory_recall', 'memory_entity'];

/*
 * arbiter 只给 read：它要能看一眼文件（判锚点合不合理、数字像不像从盘上读出来的），
 * 但只许看，不许改、不许开票、不许 exec——判定以 JSON 回来，动作归后面的 judge 和 dispatcher。
 */
const DEFAULT_ARBITER_ALLOW = ['read'];


/*
 * maxTokens 现在默认给一个有限值（judge 4000 / stage2 8000 / stage1 2000），
 * 不再走「0 = 不设上限」：不给就会落到服务端默认，终审被截在 870 字符、
 * JSON 没闭合，整拍白跑。
 *
 * 0 是上一版「不限」的老写法：schema 仍放行（min(0)），apply 里由 clamp*MaxTokens
 * 按默认值归一，并打一行日志，不让「写了 0 其实没设」再悄悄发生。
 *
 * provider / model 留空不是「用宿主默认路由」——宿主没有这个回退：
 * dsh-agent 的 AgentModel.current() 只认显式 provider+model（lib/index.js:193-197），
 * 空着就在 dsh-agent-loop 抛 "has no provider/model"，一步都不跑。
 * 所以这一段要显式配；arbiter 例外，它在 apply 里跟随提议器的路由（见 resolveArbiterRoute）。
 */
const sectionBase = (allow, timeoutMs, maxTokens = JUDGE_MAX_TOKENS_DEFAULT) => ({
  enabled: z.boolean().default(true),
  provider: z.string().default(''),
  model: z.string().default(''),
  maxTokens: z.number().step(1).min(0).default(maxTokens),
  /*
   * 推理档位：不填就不往 agentOptions 里写，请求走服务端默认。
   * 只认 low/high/max 三档（cordis.patch.yml 的 reasoningEfforts）；
   * 宿主 schema 只查「非空字符串」不查值，所以在这层就挡掉 medium 这种；
   * routeOptions 里还会再白名单过滤一次。
   */
  // schemastery 没有 .optional()：字段默认就是可缺省的，写 .optional() 会在 import 时崩。
  reasoningEffort: z.union([z.const('low'), z.const('high'), z.const('max')]),
  timeoutMs: z.number().step(1000).min(1000).default(timeoutMs),
  allow: z.array(z.string()).default(allow),
});

/**
 * 提议器的策略项：素材池、原语/对象开关、stage1 候选上限、stage2 的 token 上限。
 * 规则第六节：这些都是提示词与规则枚举的输入，改动不影响流程结构。
 *
 * materials 每条是 `{ text, motivation }`；motivation 的档位在 proposer.js 的
 * PROPOSER_MOTIVATIONS 里，未知值不在这里拒（z.enum 会整块拒加载），
 * 由 normalizeMaterials 剔条 + 日志。
 */
const PROPOSER_PRIMITIVES = {
  inspect: true,
  editFile: true,
  editConfig: true,
  service: false,
  memoryWrite: false,
  delete: true,
  outbound: false,
  externalResearch: true,
};

const PROPOSER_OBJECTS = {
  files: true,
  config: true,
  service: true,
  memory: true,
  ticket: true,
  session: true,
  externalDoc: true,
  externalRepo: true,
};

const PROPOSER_RESEARCH = {
  ttlDays: 7,
  maxFetchesPerRound: 3,
  peakOff: true,
};

const MaterialSection = z.object({
  text: z.string().default(''),
  // 档位白名单：backlog / hygiene / sync / social / memory / status / self
  motivation: z.string().default(''),
});

const ProposerSection = z.object({
  ...sectionBase(DEFAULT_PROPOSER_ALLOW, PROPOSER_TIMEOUT_MS, STAGE1_MAX_TOKENS_DEFAULT),
  // stage1 规则枚举的候选上限
  maxCandidates: z.number().step(1).min(1).default(24),
  /*
   * 打回重写的次数上限：schema 只收数字，范围由 apply 里的 clampMaxRewrite 夹到 1–5。
   * 不在 schema 写 min/max 是故意的：配成 99 / 0 要夹到边界并打 warn，不是整块拒加载。
   */
  maxRewrite: z.number().default(DEFAULT_MAX_REWRITE),
  // stage2 的 maxTokens：默认 8000（输出的结构化字段最多的一段）；老配置写 0 按默认归一
  stage2MaxTokens: z.number().step(1).min(0).default(STAGE2_MAX_TOKENS_DEFAULT),
  materials: z.array(MaterialSection).default(PROPOSER_MATERIALS),
  // 原语开关：关掉的原语整条不进候选（规则第三节八条）
  primitives: z.object({
    inspect: z.boolean().default(true),
    editFile: z.boolean().default(true),
    editConfig: z.boolean().default(true),
    service: z.boolean().default(false),
    memoryWrite: z.boolean().default(false),
    delete: z.boolean().default(true),
    outbound: z.boolean().default(false),
    externalResearch: z.boolean().default(true),
  }).default(PROPOSER_PRIMITIVES),
  // 对象类别开关（规则第四节）
  objects: z.object({
    files: z.boolean().default(true),
    config: z.boolean().default(true),
    service: z.boolean().default(true),
    memory: z.boolean().default(true),
    ticket: z.boolean().default(true),
    session: z.boolean().default(true),
    externalDoc: z.boolean().default(true),
    externalRepo: z.boolean().default(true),
  }).default(PROPOSER_OBJECTS),
  // 外部检索：缓存 TTL 与单拍抓取上限
  research: z.object({
    ttlDays: z.number().step(1).min(0).default(7),
    maxFetchesPerRound: z.number().step(1).min(0).default(3),
    peakOff: z.boolean().default(true),
  }).default(PROPOSER_RESEARCH),
  /*
   * 读建议的配置覆盖（可选）：`{ objectKind: [路径或读法, ...] }`，给了就整类替换
   * 运行时枚举结果。schema 只收 any：写成 z.dict 的话，
   * 数组里混进一个非字符串就整块配置拒加载；这里宁可收下、由 apply 里的
   * normalizeReadHints 剔掉非法值并打日志。
   */
  readHints: z.any().default({}),
});

/** 终审多三个策略项：ask 文案的长度与禁词，外加 intent 契约的灰度开关 */
const JudgeSection = z.object({
  ...sectionBase(DEFAULT_JUDGE_ALLOW, JUDGE_TIMEOUT_MS),
  askMinChars: z.number().step(1).min(1).default(ASK_MIN_CHARS),
  askMaxChars: z.number().step(1).min(1).default(ASK_MAX_CHARS),
  forbiddenWords: z.array(z.string()).default(ASK_FORBIDDEN),
  /*
   * intentRequired=false（默认）：终审没给 intent 的 do 照旧放行，老格式行为一点不变。
   * =true：缺 intent 的 do 按 reversibility=none 处理，gate 会把它降级成 ask。
   * 先观察字段齐全率，稳定了再打开；直接默认开会把现有裁决全降级。
   */
  intentRequired: z.boolean().default(false),
});

/**
 * arbiter 关：gate 判不了的灰色条目（GA3 非本地类 / GA4 锚点形状 / GA10 数字对账 / GA17 素材）
 * 打包成一批交给它逐条判 pass|reject|downgrade。
 *
 * reasoningEffort 默认 low：它只逐条判「这条该不该拦」，不需要深想；写在这里覆盖
 * sectionBase 的「不填走服务端默认」。maxCases 越界不拒加载，apply 里夹到 1–24 并打日志。
 *
 * provider/model 不写就跟随提议器（apply 里补，日志留一行）：profile 里 arbiter
 * 整段缺省是常态，空着会让会话 0.1 秒 turn/end error，条目却全按 unsupported 放行。
 */
const ArbiterSection = z.object({
  ...sectionBase(DEFAULT_ARBITER_ALLOW, ARBITER_TIMEOUT_MS, ARBITER_MAX_TOKENS_DEFAULT),
  reasoningEffort: z.union([z.const('low'), z.const('high'), z.const('max')]).default('low'),
  /*
   * 只收 any：配置里写 `maxCases: abc` 不该让整块 arbiter 拒加载。
   * 非法值 / 越界在 apply 里由 clampArbiterMaxCases 回落默认或夹边界，并打一行日志。
   */
  maxCases: z.any().default(ARBITER_MAX_CASES_DEFAULT),
});

export const Config = z.object({
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  delayMaxMinutes: z.number().step(1).min(0).max(59).default(8),
  diceProbability: z.number().min(0).max(1).default(0.35),
  /*
   * 「多久判一次」的调度周期（分钟）。默认 60 = 每个整点，与改造前逐字一致。
   * 合法值只收 1–60 且能整除 60 的整数（cron 里每 N 分钟的边界才对得上周期起点）；
   * 非法值在 apply 里回落 60 并打一行日志，不拒加载。
   *
   * ⚠ 这是真间隔：调成 10 就是每 10 分钟真判一次，拍内仍按 diceProbability 掷骰，
   * 所以实际干活频率会明显上升；票台闸只在「正好有活」时挡掉那一拍。
   */
  tickIntervalMinutes: z.number().default(60),
  /*
   * 票台闸：dispatcher 票台上存在 open / running / waiting / blocked 任意一张时，
   * 这一拍直接轮空（不提议、不开票、不发消息），只记日志和 state.busySkips。
   * 查不到票台（服务不在、库打不开）按「不空」保守跳过。
   */
  skipWhenTicketsBusy: z.boolean().default(true),
  offPeakOnly: z.boolean().default(true),
  // 小数小时：23.66 = 23:40
  quietStart: z.number().min(0).max(24).default(23.66),
  quietEnd: z.number().min(0).max(24).default(8),
  privateOnly: z.boolean().default(true),
  holidays: z.array(z.string()).default([]),
  targetSession: z.string().default(''),
  // outbound 原语允许发往的会话 id（c2c:<openid> 或 group:<openid>）；空表示一律不许发
  outboundTargets: z.array(z.string()).default([]),
  pendingTtlMinutes: z.number().min(0).default(30),
  openTimeoutMs: z.number().step(1000).min(1000).default(30000),
  maxFailStreak: z.number().step(1).min(1).default(3),
  backoffMinutes: z.number().min(0).default(60),
  // 名字里的 qq 是历史包袱：现在指聊天前端的模型偏好文件，路径/格式由前端自己定
  qqPrefsPath: z.string().default(path.join(os.homedir(), '.dsh-ego', 'model-prefs.json')),
  // 聊天前端挂在 ctx 上的偏好服务名；没这个服务就退回读文件
  prefsService: z.string().default('qqbot/prefs'),
  statePath: z.string().default(path.join(os.homedir(), '.dsh-ego', 'state.json')),
  logPath: z.string().default(path.join(os.homedir(), '.dsh-ego', 'dsh-ego.log')),
  // 否决台账：一行一条 JSONL，append-only；路径可用 vetoPath 或 DSH_EGO_ROOT 覆盖
  vetoEnabled: z.boolean().default(true),
  vetoPath: z.string().default(path.join(os.homedir(), '.dsh-ego', 'veto.jsonl')),
  // 方案落盘（一行一条 JSONL，超 20MB / 3000 行轮转成 .1）：gate 回归的重放原料
  plansPath: z.string().default(DEFAULT_PLANS_PATH),
  // 调试用：touch 这个文件，15 秒内立刻跑一拍（跳过骰子和时段限制）
  forceTriggerPath: z.string().default(DEFAULT_FORCE_PATH),
  forceIntervalMs: z.number().step(1000).min(1000).default(DEFAULT_FORCE_INTERVAL_MS),
  // 每次重启、插件起来后跟用户说一句「醒了」，每进程一次
  announceOnStart: z.boolean().default(true),
  announceDelayMs: z.number().step(1000).min(0).default(DEFAULT_ANNOUNCE_DELAY_MS),
  // 兜底没发出去后的补发窗口：窗口内每秒看一眼会话活没活，活了立刻补发一次
  announceRetryWindowMs: z.number().step(1000).min(0).default(DEFAULT_ANNOUNCE_RETRY_WINDOW_MS),
  // 整句自报模板，`{version}` 换成插件版本号；不写就用默认那句（只换人称/改语气也走这项）
  announceTemplate: z.string().min(1).max(500).pattern(/\S/).default(DEFAULT_ANNOUNCE_TEMPLATE),
  proposer: ProposerSection,
  judge: JudgeSection,
  arbiter: ArbiterSection,
});

/** 旧配置混着来、或 loader 没走 schema 时的兜底；字段与 cordis.patch.yml 对齐 */
const DEFAULTS = {
  enabled: true,
  dryRun: false,
  delayMaxMinutes: 8,
  diceProbability: 0.35,
  // 调度周期（分钟）。默认 60 = 每小时一拍，与改造前一致；10 = 每 10 分钟真判一次
  tickIntervalMinutes: 60,
  // 票台有未终态票就跳过这一拍；查不到票台也按不空处理
  skipWhenTicketsBusy: true,
  offPeakOnly: true,
  quietStart: 23.66,
  quietEnd: 8,
  privateOnly: true,
  holidays: [],
  targetSession: '',
  // GA14 的白名单：空 = 一律不许发（schema 那边默认也是 []，旧配置漏这一栏时靠这里补）
  outboundTargets: [],
  pendingTtlMinutes: 30,
  openTimeoutMs: 30000,
  maxFailStreak: 3,
  backoffMinutes: 60,
  qqPrefsPath: path.join(os.homedir(), '.dsh-ego', 'model-prefs.json'),
  prefsService: 'qqbot/prefs',
  statePath: path.join(os.homedir(), '.dsh-ego', 'state.json'),
  logPath: path.join(os.homedir(), '.dsh-ego', 'dsh-ego.log'),
  vetoEnabled: true,
  vetoPath: path.join(os.homedir(), '.dsh-ego', 'veto.jsonl'),
  plansPath: DEFAULT_PLANS_PATH,
  forceTriggerPath: DEFAULT_FORCE_PATH,
  forceIntervalMs: DEFAULT_FORCE_INTERVAL_MS,
  announceOnStart: true,
  announceDelayMs: DEFAULT_ANNOUNCE_DELAY_MS,
  announceRetryWindowMs: DEFAULT_ANNOUNCE_RETRY_WINDOW_MS,
  announceTemplate: DEFAULT_ANNOUNCE_TEMPLATE,
  proposer: {
    enabled: true,
    provider: '',
    model: '',
    // stage1 那一档（默认 2000，区间 2000–16000）：现在 stage1 是纯规则枚举、0 次模型调用，
    // 这一项留作接口；apply 里照旧夹边界，日后接上 stage1 会话直接能用。
    maxTokens: STAGE1_MAX_TOKENS_DEFAULT,
    timeoutMs: PROPOSER_TIMEOUT_MS,
    allow: DEFAULT_PROPOSER_ALLOW,
    materials: PROPOSER_MATERIALS,
    maxCandidates: 24,
    // 打回重写最多几次：apply 里会夹到 1–5
    maxRewrite: DEFAULT_MAX_REWRITE,
    // stage2 默认 8000（区间 2000–16000）：要输出 object/evidence/plan/intent 一大串字段
    stage2MaxTokens: STAGE2_MAX_TOKENS_DEFAULT,
    primitives: PROPOSER_PRIMITIVES,
    objects: PROPOSER_OBJECTS,
    research: PROPOSER_RESEARCH,
    // 读建议的配置覆盖（空 = 用运行时枚举，见 lib/read-hints.js）
    readHints: {},
  },
  judge: {
    enabled: true,
    provider: '',
    model: '',
    // 终审默认 4000（区间 1000–8000）：870 字符那次就是没上限被服务端截断
    maxTokens: JUDGE_MAX_TOKENS_DEFAULT,
    timeoutMs: JUDGE_TIMEOUT_MS,
    allow: DEFAULT_JUDGE_ALLOW,
    askMinChars: ASK_MIN_CHARS,
    askMaxChars: ASK_MAX_CHARS,
    forbiddenWords: ASK_FORBIDDEN,
    intentRequired: false,
  },
  arbiter: {
    enabled: true,
    provider: '',
    model: '',
    // 只回一段小 JSON，1500 够（区间 500–4000）
    maxTokens: ARBITER_MAX_TOKENS_DEFAULT,
    // 逐条判「该不该拦」，不需要深想：默认 low（跟题面口径一致）
    reasoningEffort: 'low',
    timeoutMs: ARBITER_TIMEOUT_MS,
    allow: DEFAULT_ARBITER_ALLOW,
    maxCases: ARBITER_MAX_CASES_DEFAULT,
  },
};


export { DEFAULT_PROPOSER_ALLOW, DEFAULT_JUDGE_ALLOW, DEFAULT_ARBITER_ALLOW, ProposerSection, JudgeSection, ArbiterSection, DEFAULTS };
