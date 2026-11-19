/**
 * dsh-ego — 主动念头（两阶段 + 裁决）
 *
 * 一拍三段，只有中间那一段花模型：
 *   1. stage1 规则枚举（lib/grid.js，纯函数、0 次模型）：素材 × 原语 × 对象 → 候选格；
 *      空就这一拍不动作（日志 stage1_empty），不叫模型；
 *   2. stage2 一次模型调用：代码按确定顺序挑一格交给它，它把那一格做实成方案
 *      （idea / why / object / evidence / plan / intent），解析在 proposer.js 的 parseStage2Plan；
 *      stage2 拿不出合法方案就是这一拍不动作（日志 stage2_fail），不降级、不回退一阶段；
 *   3. 终审（独立上下文，只看 idea 和 why）四选一：
 *        silent 无动作 / ask 跟用户说一句 / do 直接开票 / rewrite 打回 stage2 同一会话重写。
 *
 * 三条硬规矩：
 *   · 「无动作」这一支绝不产生任何消息，也不 followup 主会话，只写本地日志和 state；
 *   · 临时 agent 用完必须 dispose（dispose 不删 sessions 目录里的文件，漏一次就是永久垃圾），
 *     所以每一段都走 runAgent / openAgentSession 的 try/finally + 硬超时；
 *   · 说话是插件自己干；开票只在主会话那边提申请，两段 agent 的白名单里都没有 send_message / dispatch_*。
 *
 * 目标会话自己学：监听到用户在私聊里的下一条消息就记住它；配置 targetSession 写死优先。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { ArbiterSection, DEFAULTS, JudgeSection, ProposerSection } from './config.js';
import {
  PLUGIN_DIR,
  REPO_ROOT,
  checkExistsFrom,
  checkFileLineFrom,
  fmt,
  makePrefsReader,
  makeScopeResolver,
  probed,
  readVersion,
} from './helpers.js';
import { ensureDir, readState, writeState } from './state.js';
import { openAgentSession, runAgent } from './agent-run.js';
import { clampArbiterMaxTokens, clampJudgeMaxTokens, clampStage1MaxTokens, clampStage2MaxTokens } from './budget.js';
import { clampMaxRewrite, normalizeMaterials, parseStage2Plan } from './proposer.js';
import { clampArbiterMaxCases, resolveArbiterRoute } from './arbiter.js';
import { DEFAULT_PLANS_PATH } from './plans-log.js';
import { createReadHintCache, defaultReadRoots, normalizeReadHints } from './read-hints.js';
import { createGate, normalizeOutboundTargets } from './gate.js';
import { DEFAULT_FORCE_INTERVAL_MS, DEFAULT_FORCE_PATH } from './force.js';
import { DEFAULT_ANNOUNCE_DELAY_MS, DEFAULT_ANNOUNCE_TEMPLATE } from './announce.js';
import { DEFAULT_ANNOUNCE_RETRY_WINDOW_MS } from './announce-retry.js';
import { clipLogText } from './text.js';
import { normalizeTickIntervalMinutes } from './hourly.js';
import { createTicketProbe } from './ticket-gate.js';
import { createProposer } from './engines/proposer.js';
import { createSolutionPoolProvider, DEFAULT_BACKLOG_DB } from './backlog-pool.js';
import { createAdjudicator } from './engines/adjudicator.js';
import { createRoundEngine } from './engines/round.js';
import { createLifecycle } from './engines/lifecycle.js';

export const name = 'dsh-ego';
// agents 建临时 agent，tools 要探白名单和调 dispatch_open；少写一个整个插件加载失败
export const inject = ['agents', 'tools'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  delayMaxMinutes: z.number().step(1).min(0).max(59).default(8),
  diceProbability: z.number().min(0).max(1).default(0.35),
  // 「多久判一次」的调度周期（分钟）：默认 60 = 每小时，与改造前一致；10 = 每 10 分钟真判一次
  tickIntervalMinutes: z.number().default(60),
  // 票台闸：dispatcher 有未终态票时这一拍轮空；查不到票台按不空保守跳过
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
  // 工单池库（solution 动机每拍只读取「已定方案」）；只读，读不到按空池处理
  backlogPath: z.string().default(DEFAULT_BACKLOG_DB),
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
// 组合键与 recentCombos 记账的纯函数在 lib/combo.js（提议器/裁决器共用同一份口径），
// 这里保留旧的导出名给入口测试与外部调用方。
export { RECENT_COMBOS_LIMIT, rememberComboIn } from './combo.js';

export function apply(ctx, config) {
  const cfg = {
    ...DEFAULTS,
    ...config,
    proposer: { ...DEFAULTS.proposer, ...(config?.proposer ?? {}) },
    judge: { ...DEFAULTS.judge, ...(config?.judge ?? {}) },
  };
  /*
   * 校验层收成一个 Gate（架构图 ② 代码规则 / ③ 裁决规则），规则全从 section 配置来：
   * objectHints 只管点子里的对象，ask 三项管 ask 文案，brief 列宽暂时只有默认 34。
   * 两阶段起 objectHints 已从 proposer 段删掉（没有名字表可传），这里给空表，
   * 对象的存在性留给 gate 后续批次按实测校验；一拍内规则不变，apply 时建一次。
   */
  const gate = createGate({
    objectHints: [],
    ask: {
      minChars: cfg.judge.askMinChars,
      maxChars: cfg.judge.askMaxChars,
      forbidden: cfg.judge.forbiddenWords,
    },
    // 灰度开关：false 时缺 intent 的 do 照旧放行
    intentRequired: cfg.judge.intentRequired,
    /*
     * GA14 的白名单（配置项 `outboundTargets`，元素 `c2c:<openid>` / `group:<openid>`）。
     * 这里归一一次：schema 默认给 []，旧配置/手写配置漏这一栏时 normalizeOutboundTargets
     * 也回 []，不让 undefined 漏进 gate（空表 = outbound 一律不许发）。
     */
    outboundTargets: normalizeOutboundTargets(cfg.outboundTargets),
    /*
     * GA3/GA4/GA5 要读盘，gate 自己不 import fs；真实现从这里注入，单测传 stub。
     *
     * 相对路径按哪个 cwd 解析：模型写的 anchor 多是 `lib/gate.js`（相对插件目录），
     * 也会写 `plugins/dsh-ego/lib/gate.js`（相对仓库根）。两种都试一次：先插件目录，
     * 查不到再按仓库根查。进程的 cwd 是宿主起的目录，不能拿来当基准。
     */
    deps: {
      checkExists: (object) => checkExistsFrom(PLUGIN_DIR, REPO_ROOT, object),
      checkFileLine: (anchor) => checkFileLineFrom(PLUGIN_DIR, REPO_ROOT, anchor),
    },
  });
  const logger = ctx.logger ?? console;
  const stateFile = cfg.statePath;
  const state = readState(stateFile);
  const readPrefs = makePrefsReader(ctx, cfg.qqPrefsPath, logger, cfg.prefsService);
  const scopeOf = makeScopeResolver(readPrefs);

  /*
   * 日志单行可以长：校验失败时要能看见原文，不再在写日志这一步把话切掉。
   * 曾经用 result.text.slice(0, 160) 写日志，看着像模型输出截断，其实回复完整闭合——
   * 那只是显示时切的，不是真截断。现在只有真超长（4000 字符）才截，
   * 且末尾写明「日志截断，原文 N 字符」。
   */
  function log(line) {
    const msg = `[${new Date().toISOString()}] ${clipLogText(line)}`;
    try {
      ensureDir(cfg.logPath);
      fs.appendFileSync(cfg.logPath, `${msg}\n`, 'utf8');
    } catch {
      /* 日志写不了就走 logger */
    }
    logger.debug?.(msg);
  }

  function save() {
    writeState(stateFile, state);
  }

  /*
   * 调度周期：
   *   · tickIntervalMinutes 只收 1–60 且能整除 60 的整数（cron 里每 N 分钟的边界才跟周期对齐），
   *     非法值回落 60 并打一行日志，不拒加载；默认 60 与改造前一致；
   *   · delayMaxMinutes 夹到「周期 - 1」：1 分钟档不许把下一拍排进下个周期；
   *     默认 60 时 min(8, 59) = 8，排期行为一字不变。
   */
  const rawInterval = cfg.tickIntervalMinutes;
  cfg.tickIntervalMinutes = normalizeTickIntervalMinutes(rawInterval);
  if (rawInterval !== undefined && rawInterval !== null && Number(rawInterval) !== cfg.tickIntervalMinutes) {
    log(`tickIntervalMinutes=${JSON.stringify(rawInterval)} 不合法（只收 1–60 且能整除 60 的整数），按 ${cfg.tickIntervalMinutes} 跑`);
  }
  const delayCap = cfg.tickIntervalMinutes - 1;
  if (Number(cfg.delayMaxMinutes) > delayCap) {
    log(`delayMaxMinutes=${cfg.delayMaxMinutes} 超过周期上限，按 ${delayCap} 跑（周期 ${cfg.tickIntervalMinutes} 分钟）`);
    cfg.delayMaxMinutes = delayCap;
  }

  // 配置越界只夹边界 + 打 warn，不拒加载：maxRewrite 配成 99/0 不该让整块 proposer 挂掉
  cfg.proposer.maxRewrite = clampMaxRewrite(cfg.proposer.maxRewrite, {
    warn: (line) => log(line),
  });

  /*
   * 三段输出预算同样只夹不拒（见 lib/budget.js）：
   *   judge.maxTokens          1000–8000，默认 4000
   *   proposer.maxTokens       2000–16000，默认 2000（stage1 档，暂无量模型消费点）
   *   proposer.stage2MaxTokens 2000–16000，默认 8000
   * 老配置里的 0（上一版「不限」）按默认归一，并打一行日志。
   */
  const budgetWarn = { warn: (line) => log(line) };
  cfg.judge.maxTokens = clampJudgeMaxTokens(cfg.judge.maxTokens, budgetWarn);
  cfg.proposer.maxTokens = clampStage1MaxTokens(cfg.proposer.maxTokens, budgetWarn);
  cfg.proposer.stage2MaxTokens = clampStage2MaxTokens(cfg.proposer.stage2MaxTokens, budgetWarn);
  cfg.arbiter.maxTokens = clampArbiterMaxTokens(cfg.arbiter.maxTokens, budgetWarn);
  // 一次送几条：非法 / 越界只夹边界并打日志，不拒加载（跟 maxRewrite 一个口径）
  const rawMaxCases = cfg.arbiter.maxCases;
  cfg.arbiter.maxCases = clampArbiterMaxCases(rawMaxCases);
  if (rawMaxCases !== undefined && rawMaxCases !== null && Number(rawMaxCases) !== cfg.arbiter.maxCases) {
    log(`arbiter.maxCases=${JSON.stringify(rawMaxCases)} 越界或不是整数，按 ${cfg.arbiter.maxCases} 跑`);
  }
  /*
   * arbiter 的路由：宿主没有「默认模型」回退，provider/model 空着就是 0.1 秒
   * turn/end error（"has no provider/model"），一条判定都出不来。
   * 配置里 arbiter 段常常整段缺省，所以让它跟随提议器；两边都空就留空，
   * 由 agent 那边把原话带进日志（emptyReplyError 会带出 finish=error 的原文）。
   */
  const arbiterRoute = resolveArbiterRoute(cfg.arbiter, cfg.proposer);
  cfg.arbiter = arbiterRoute.section;
  if (arbiterRoute.followed.length > 0) {
    log(`arbiter 的 ${arbiterRoute.followed.join('/')} 跟提议器走：${cfg.arbiter.provider}/${cfg.arbiter.model}`);
  }
  if (!String(cfg.arbiter.provider ?? '').trim() || !String(cfg.arbiter.model ?? '').trim()) {
    log('arbiter 缺 provider/model（提议器也没配），这一关会立刻失败、条目按 unsupported 放行：请在 proposer 或 arbiter 里配路由');
  }
  log(
    `四段输出预算：judge ${cfg.judge.maxTokens}｜stage2 ${cfg.proposer.stage2MaxTokens}`
      + `｜stage1 ${cfg.proposer.maxTokens}｜arbiter ${cfg.arbiter.maxTokens}`,
  );

  /*
   * 读建议：候选行末尾只留 `#C0N` 指针，路径由 ego 运行时枚举，
   * 单列到 stage2 提示词末尾「可读位置（按候选编号）」区块，
   * 不做静态表（会过期、要人维护）。
   *   · 枚举范围固定在 defaultReadRoots()：~/.dsh/profiles/<name>/cordis.patch.yml、
   *     ~/fatfish/plugins/<name>/cordis.patch.yml、~/.dsh/settings.yaml、
   *     ~/fatfish/logs/<name>.log；
   *   · 进程内 60 秒 TTL：一拍最多扫一次盘，多拍共用；
   *   · 配置覆盖 proposer.readHints 在这里先归一一次，非法值只打一次日志，不每拍刷。
   */
  const readHintCache = createReadHintCache();
  const readRoots = defaultReadRoots();
  const readHintOverride = normalizeReadHints(cfg.proposer.readHints, { log: (line) => log(line) });

  /*
   * 白名单**不在 apply 时剔**。
   *
   * 旧写法在 apply 阶段用 ctx.tools.executable(name) 逐条探一遍，两个判据都是错的：
   *   1. apply 的先后由依赖就绪顺序决定，不是配置行顺序；探的那一刻别的插件可能还没
   *      register（实测裸 base 组合 apply 时全局可见 0 条，3 秒后才 25 条）。
   *   2. executable(name) 不带 toolSet 时对带 when 的条件注册一律返回 undefined，
   *      web_search/web_fetch 正是条件注册，所以它俩必然被误剔。
   * 现在改成 setup(childCtx, childAgent) 里按子 agent 视角筛（见 lib/agent-run.js 的
   * selectAllow），配置里写什么就照原样留着，坏名字由那一步剔掉并记日志。
   */
  log(
    `白名单按配置原样保留（提议器 ${cfg.proposer.allow.length} 项、终审 ${cfg.judge.allow.length} 项），` +
      '实际可见性在每次建临时 agent 时按它的视角过滤',
  );

  /*
   * 素材池收一遍：motivation 不在档位里的条目剔掉并记日志，不拒加载。
   * schema 里 motivation 是宽 string，就是为了别让一条拼错把整块 proposer 配置顶掉；
   * 剔掉哪几条要写进日志，不然配置里写错了没人知道它没进提示词。
   */
  const materialReview = normalizeMaterials(cfg.proposer.materials);
  cfg.proposer.materials = materialReview.materials;
  log(`素材池 ${materialReview.materials.length} 条进提示词${materialReview.dropped.length > 0 ? `，剔掉 ${materialReview.dropped.length} 条` : ''}`);
  for (const item of materialReview.dropped) {
    log(`素材被剔：${item.why}｜${clipLogText(item.text)}`);
  }

  // ── 裁决器（终审 + 否决台账 + arbiter，实现在 lib/engines/adjudicator.js）──
  const adjudicator = createAdjudicator({ cfg, state, log, gate, ctx });

  // ── 第一段：提议器（stage1 规则枚举 + stage2 方案，实现在 lib/engines/proposer.js）──
  /*
   * solution 的「已定方案」池：一拍取一次，provider 注入给提议器。
   * 提议器不直接碰 sqlite——库不在 / 表没有 / 驱动不可用都只记一行日志、回空池。
   */
  const readSolutionPool = createSolutionPoolProvider({ file: cfg.backlogPath, log });
  const proposer = createProposer({
    cfg,
    state,
    save,
    log,
    gate,
    ctx,
    readSolutionPool,
    judge: adjudicator.judge,
    checkVetoFor: adjudicator.checkVetoFor,
    arbiter: adjudicator.arbiter,
    readRoots,
    readHintCache,
    readHintOverride,
  });

  // ── 一拍引擎（ask / 开票 / runRound / 补发 / tick，实现在 lib/engines/round.js）──
  // 票台闸的探针：dispatcher/tickets 服务优先，服务不在退只读 sqlite，读不到按不空
  const ticketProbe = createTicketProbe({ ctx });
  const round = createRoundEngine({
    cfg,
    state,
    save,
    log,
    gate,
    ctx,
    proposer,
    adjudicator,
    scopeOf,
    fmt,
    ticketProbe,
  });

  // ── 生命周期接线（补发 / 自报 / 学习 / 整点 / 兜底轮询 / 两个工具）──
  createLifecycle({ cfg, state, save, log, logger, ctx, round, scopeOf, fmt, readVersion, probed });
}
