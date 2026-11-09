/**
 * dsh-ego — 主动念头（两段式）
 *
 * 拆成两段 agent：
 *   1. 提议器（只读工具）想一个具体的点子，输出 { idea, why }；
 *   2. 裁决器（独立上下文，只看点子原文和 why）三选一：
 *        silent 无动作 / ask 跟用户说一句 / do 直接开票让这件事自己做完。
 *
 * 三条硬规矩：
 *   · 「无动作」这一支绝不产生任何消息，也不 followup 主会话，只写本地日志和 state；
 *   · 临时 agent 用完必须 dispose（dispose 不删 sessions 目录里的文件，漏一次就是永久垃圾），
 *     所以每一段都走 runAgent 的 try/finally + 硬超时；
 *   · 说话和开票都是插件自己干，两段 agent 的白名单里都没有 send_message / dispatch_*。
 *
 * 目标会话自己学：监听到用户在私聊里的下一条消息就记住它；配置 targetSession 写死优先。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { delayMs, hit, isPeak, nextWindow, rollDice, speakingWindow } from './window.js';
import { ensureDir, prunePending, readState, recordFailure, recordSuccess, writeState } from './state.js';
import { ackPendingByKey, enqueuePending, hasPendingItems, pendingCount, pendingHead } from './pending-queue.js';
import { JUDGE_TIMEOUT_MS, PROPOSER_TIMEOUT_MS, UNLIMITED_MAX_TOKENS, routeOptions, runAgent } from './agent-run.js';
import { IDEA_OBJECT_HINTS, PROPOSER_MATERIALS, buildProposerPrompt, parseProposal } from './proposer.js';
import { ASK_FORBIDDEN, ASK_MAX_CHARS, ASK_MIN_CHARS, buildJudgePrompt, parseDecisionReport } from './judge.js';
import { createTicketOpener, routeDecision } from './route.js';
import { DEFAULT_FORCE_INTERVAL_MS, DEFAULT_FORCE_PATH, checkForceGate, createForceWatcher, runForcedRound } from './force.js';
import { isKnownScope, isDirectScope } from './scope.js';
import { DEFAULT_ANNOUNCE_DELAY_MS, DEFAULT_ANNOUNCE_TEMPLATE, announceWaitMs, createAnnouncer } from './announce.js';
import { createAnnounceGate } from './announce-gate.js';
import { createPendingFlusher } from './flush.js';
import { clipLogText, clipText } from './text.js';
import { acceptTick, tickPeriodKey, wakeAtForTick } from './hourly.js';
import { attachServiceWatch, createHourlyDriver } from './hourly-driver.js';

export const name = 'dsh-ego';
// agents 建临时 agent，tools 要探白名单和调 dispatch_open；少写一个整个插件加载失败
export const inject = ['agents', 'tools'];

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
 * 0 = 不设上限：不往 agentOptions 里写 maxTokens，请求体里也就没有 max_tokens 字段。
 * 宿主会拒掉 <= 0 的 maxTokens（TypeError），所以「不限」只能是「不传」，不能是「传 0」。
 *
 * provider / model 默认留空 = 用宿主自己的默认路由；要指定就填你自己的服务商和模型名。
 */
const sectionBase = (allow, timeoutMs, maxTokens = UNLIMITED_MAX_TOKENS) => ({
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
 * 提议器多两个策略项：素材池与对象名词表（都是提示词内容，改动不影响流程）。
 * 代码里只留空兜底，默认清单在 cordis.patch.yml；没配就空着，不注入私人方向。
 */
const ProposerSection = z.object({
  ...sectionBase(DEFAULT_PROPOSER_ALLOW, PROPOSER_TIMEOUT_MS),
  materials: z.array(z.string()).default(PROPOSER_MATERIALS),
  objectHints: z.array(z.string()).default(IDEA_OBJECT_HINTS),
});

/** 裁决器多三个策略项：ask 文案的长度与禁词 */
const JudgeSection = z.object({
  ...sectionBase(DEFAULT_JUDGE_ALLOW, JUDGE_TIMEOUT_MS),
  askMinChars: z.number().step(1).min(1).default(ASK_MIN_CHARS),
  askMaxChars: z.number().step(1).min(1).default(ASK_MAX_CHARS),
  forbiddenWords: z.array(z.string()).default(ASK_FORBIDDEN),
});

export const Config = z.object({
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  delayMaxMinutes: z.number().step(1).min(0).max(59).default(8),
  diceProbability: z.number().min(0).max(1).default(0.35),
  offPeakOnly: z.boolean().default(true),
  // 小数小时：23.66 = 23:40
  quietStart: z.number().min(0).max(24).default(23.66),
  quietEnd: z.number().min(0).max(24).default(8),
  privateOnly: z.boolean().default(true),
  holidays: z.array(z.string()).default([]),
  targetSession: z.string().default(''),
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
  // 调试用：touch 这个文件，15 秒内立刻跑一拍（跳过骰子和时段限制）
  forceTriggerPath: z.string().default(DEFAULT_FORCE_PATH),
  forceIntervalMs: z.number().step(1000).min(1000).default(DEFAULT_FORCE_INTERVAL_MS),
  // 每次重启、插件起来后跟用户说一句「醒了」，每进程一次
  announceOnStart: z.boolean().default(true),
  announceDelayMs: z.number().step(1000).min(0).default(DEFAULT_ANNOUNCE_DELAY_MS),
  // 整句自报模板，`{version}` 换成插件版本号；不写就用默认那句（只换人称/改语气也走这项）
  announceTemplate: z.string().min(1).max(500).pattern(/\S/).default(DEFAULT_ANNOUNCE_TEMPLATE),
  proposer: ProposerSection,
  judge: JudgeSection,
});

/** 旧配置混着来、或 loader 没走 schema 时的兜底；字段与 cordis.patch.yml 对齐 */
const DEFAULTS = {
  enabled: true,
  dryRun: false,
  delayMaxMinutes: 8,
  diceProbability: 0.35,
  offPeakOnly: true,
  quietStart: 23.66,
  quietEnd: 8,
  privateOnly: true,
  holidays: [],
  targetSession: '',
  pendingTtlMinutes: 30,
  openTimeoutMs: 30000,
  maxFailStreak: 3,
  backoffMinutes: 60,
  qqPrefsPath: path.join(os.homedir(), '.dsh-ego', 'model-prefs.json'),
  prefsService: 'qqbot/prefs',
  statePath: path.join(os.homedir(), '.dsh-ego', 'state.json'),
  logPath: path.join(os.homedir(), '.dsh-ego', 'dsh-ego.log'),
  forceTriggerPath: DEFAULT_FORCE_PATH,
  forceIntervalMs: DEFAULT_FORCE_INTERVAL_MS,
  announceOnStart: true,
  announceDelayMs: DEFAULT_ANNOUNCE_DELAY_MS,
  announceTemplate: DEFAULT_ANNOUNCE_TEMPLATE,
  proposer: {
    enabled: true,
    provider: '',
    model: '',
    // 0 = 不限：推理模型会先烧一大段 reasoning，小上限容易被吃光、正文为空。
    maxTokens: UNLIMITED_MAX_TOKENS,
    timeoutMs: PROPOSER_TIMEOUT_MS,
    allow: DEFAULT_PROPOSER_ALLOW,
    materials: PROPOSER_MATERIALS,
    objectHints: IDEA_OBJECT_HINTS,
  },
  judge: {
    enabled: true,
    provider: '',
    model: '',
    maxTokens: UNLIMITED_MAX_TOKENS,
    timeoutMs: JUDGE_TIMEOUT_MS,
    allow: DEFAULT_JUDGE_ALLOW,
    askMinChars: ASK_MIN_CHARS,
    askMaxChars: ASK_MAX_CHARS,
    forbiddenWords: ASK_FORBIDDEN,
  },
};

const fmt = (t) => {
  if (!t) return '—';
  const d = new Date(Number(t));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 从 ctx 上摸一个服务：events / schedule 都是惰性探测，不写进 inject。
 * 硬 inject 缺服务会让整个插件不 apply——ego 的意念、pending、开机自报全跟着停，
 * 就为了等一个 tick 来源，不值。探测失败返回 undefined，降级路径自己兜。
 */
function probed(ctx, name) {
  const getter = ctx.get;
  if (typeof getter !== 'function') return undefined;
  try {
    const found = getter.call(ctx, name);
    return found === undefined || found === null ? undefined : found;
  } catch {
    return undefined;
  }
}

/** 自报里带的版本号，读不到就空着（不因为读不到版本就发不出去） */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg?.version ?? '');
  } catch {
    return '';
  }
}

/** 没轮换过的会话 id 是 sha256(sessionKey) 的前 32 位（跟宿主的派生规则一致） */
function derivedSessionId(key) {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/* ── 聊天前端的偏好：优先走服务接口，拿不到再读文件 ──────────────────
 * 路径、格式、并发写语义都归聊天前端管，这里不再自己解析。
 * 宿主没装这个服务、或它还没就绪时打一次 warning，退回读 qqPrefsPath。
 * 服务名是配置项 `prefsService`，默认按宿主约定；换了前端就改配置（或者只用文件）。
 */
function probePrefsService(ctx, serviceName) {
  if (!ctx || !serviceName) return undefined;
  let raw;
  try {
    raw = ctx.get?.(serviceName);
  } catch {
    raw = undefined;
  }
  if (raw === undefined || raw === null) {
    try {
      raw = ctx[serviceName];
    } catch {
      raw = undefined;
    }
  }
  return raw && typeof raw.payload === 'function' ? raw : undefined;
}

function fallbackReadPrefs(prefsPath) {
  try {
    return JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  } catch {
    return {};
  }
}

function makePrefsReader(ctx, prefsPath, logger, serviceName) {
  let warned = false;
  return function readPrefs() {
    const service = probePrefsService(ctx, serviceName);
    if (service) {
      try {
        const payload = service.payload();
        if (payload && typeof payload === 'object') return payload;
      } catch (error) {
        if (!warned) {
          warned = true;
          logger.warn?.(`dsh-ego: ${serviceName}.payload() 读失败，回退读文件：${String(error?.message ?? error)}`);
        }
      }
    } else if (!warned) {
      warned = true;
      logger.warn?.(`dsh-ego: 没有 ${serviceName} 服务，回退直接读 ${prefsPath}`);
    }
    return fallbackReadPrefs(prefsPath);
  };
}

/**
 * 会话 → 群聊/私聊。只学私聊（privateOnly），所以这张表只回答「这个会话是不是私聊」。
 * 查不到就当不知道，宁可不学。
 */
function makeScopeResolver(readPrefs) {
  let cache = { at: 0, map: new Map() };
  return function scopeOf(sessionId) {
    if (!sessionId) return undefined;
    if (Date.now() - cache.at > 60_000) {
      const map = new Map();
      try {
        const data = readPrefs();
        const keys = new Set([
          ...Object.keys(data.sessionIds ?? {}),
          ...Object.keys(data.overrides ?? {}),
          ...Object.keys(data.presets ?? {}),
        ]);
        for (const key of keys) {
          const scope = String(key).split(':')[2];
          if (!isKnownScope(scope)) continue;
          const rotated = data.sessionIds?.[key];
          if (rotated) map.set(String(rotated), scope);
          map.set(derivedSessionId(key), scope);
        }
      } catch {
        /* 读不到偏好文件：当作不知道 */
      }
      cache = { at: Date.now(), map };
    }
    return cache.map.get(sessionId);
  };
}

/** 把它自己的念头包一层，免得模型把它当成「对方发来的消息」去回答 */
function frame(text) {
  return [
    '（下面这句是你自己心里冒出来的念头，不是对方发来的消息，不用回应它，顺着它去做就行。）',
    '（这是你自己开的一轮：跟用户说一句，短，一两句就好；别说「我来汇报」这种，也别列清单。）',
    String(text ?? '').trim(),
  ].join('\n');
}

export function apply(ctx, config) {
  const cfg = {
    ...DEFAULTS,
    ...config,
    proposer: { ...DEFAULTS.proposer, ...(config?.proposer ?? {}) },
    judge: { ...DEFAULTS.judge, ...(config?.judge ?? {}) },
  };
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

  /** 目标会话：配置里写死的优先，否则用学到的 */
  function targetId() {
    return String(cfg.targetSession || state.targetSession || '').trim();
  }

  function findAgent(id) {
    if (!id) return undefined;
    const candidates = [id];
    if (id.startsWith('session-')) candidates.push(id.slice('session-'.length));
    else candidates.push(`session-${id}`);
    for (const one of candidates) {
      try {
        const agent = ctx.agents.get(one);
        if (agent !== undefined) return agent;
      } catch {
        /* agents 服务查不动：当作没找到 */
      }
    }
    return undefined;
  }

  function buildMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-ego' },
    };
  }

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
    `白名单按配置原样保留（提议器 ${cfg.proposer.allow.length} 项、裁决器 ${cfg.judge.allow.length} 项），` +
      '实际可见性在每次建临时 agent 时按它的视角过滤',
  );

  // ── 第一段：提议器 ───────────────────────────────────────────
  async function propose(nowMs) {
    const section = cfg.proposer;
    if (!section.enabled) return { ok: false, skipped: true, error: 'proposer.enabled = false' };
    const prompt = buildProposerPrompt({ now: new Date(nowMs), state, materials: section.materials });
    const result = await runAgent(
      { create: (options) => ctx.agents.create(options), log },
      {
        kind: 'proposer',
        prompt,
        allow: section.allow,
        timeoutMs: section.timeoutMs,
        agentPreset: 'dsh-ego-proposer',
        // routeOptions 会把 0（不限）剔掉：宿主 assertAgentOptions 拒 maxTokens <= 0
        agentOptions: routeOptions(section),
      },
    );
    if (!result.ok) return { ok: false, error: `提议器失败：${result.error}` };
    const parsed = parseProposal(result.text, { objectHints: section.objectHints });
    if (!parsed) {
      return {
        ok: false,
        error: '提议器的回复没法用（不是合法 JSON，或点子没写清对象和数量）｜' + clipText(result.text),
      };
    }
    return { ok: true, ...parsed };
  }

  // ── 第二段：裁决器 ───────────────────────────────────────────
  async function judge(proposal, nowMs) {
    const section = cfg.judge;
    if (!section.enabled) return { ok: false, skipped: true, error: 'judge.enabled = false' };
    const prompt = buildJudgePrompt({
      idea: proposal.idea,
      why: proposal.why,
      now: new Date(nowMs),
      state,
      lastReportAt: state.lastReportAt,
      lastAskAt: state.lastAskAt,
      rules: {
        minChars: section.askMinChars,
        maxChars: section.askMaxChars,
        forbidden: section.forbiddenWords,
      },
    });
    const result = await runAgent(
      { create: (options) => ctx.agents.create(options), log },
      {
        kind: 'judge',
        prompt,
        allow: section.allow,
        timeoutMs: section.timeoutMs,
        agentPreset: 'dsh-ego-judge',
        // routeOptions 会把 0（不限）剔掉：宿主 assertAgentOptions 拒 maxTokens <= 0
        agentOptions: routeOptions(section),
      },
    );
    if (!result.ok) return { ok: false, error: `裁决器失败：${result.error}` };
    const report = parseDecisionReport(result.text, {
      idea: proposal.idea,
      why: proposal.why,
      rules: {
        minChars: section.askMinChars,
        maxChars: section.askMaxChars,
        forbidden: section.forbiddenWords,
      },
    });
    if (!report.ok) {
      const label = report.scope === 'ask' ? 'ask 文案' : '裁决器回复';
      return {
        ok: false,
        error:
          `裁决器的回复不能当裁决｜被拦：${report.problems.join('；') || '未知原因'}` +
          `｜${label} ${report.len} 字符｜${clipText(report.text)}`,
      };
    }
    return { ok: true, decision: report.decision };
  }

  /**
   * 发不出去也先记着：下次这一拍再试，TTL 过了就丢（at 不刷新，才是真的 TTL）。
   * 队列按产生时间有序，同一句重复入队只保留最先那条（沿用原 at），后到的不覆盖前面的别的句子。
   */
  function rememberSay(text, at) {
    enqueuePending(state, 'say', { text, at }, { log });
    save();
  }

  // ── ask 分支：跟用户说一句（followup 主会话） ─────────────────
  async function ask(text, nowMs, { quiet = false } = {}) {
    if (cfg.dryRun) {
      log(`[dry] 本来要跟用户说：${text}`);
      state.lastAction = 'ask';
      return { ok: true, dry: true };
    }
    const id = targetId();
    if (!id) {
      rememberSay(text, nowMs);
      if (!quiet) log('还不知道跟哪个会话说话（等用户在私聊里说一句），先存着');
      return { ok: false, pending: true, detail: '没有目标会话' };
    }
    if (cfg.privateOnly && id !== cfg.targetSession && !isDirectScope(scopeOf(id))) {
      log(`会话 ${id.slice(-8)} 不是私聊，这个念头丢掉`);
      return { ok: false, detail: '目标不是私聊' };
    }
    const agent = findAgent(id);
    if (!agent) {
      rememberSay(text, nowMs);
      if (!quiet) log(`会话 ${id.slice(-8)} 不在活表（没找到活着的 agent），先存着`);
      return { ok: false, pending: true, detail: '会话不在活表' };
    }
    if (agent.status !== undefined && agent.status !== 'idle') {
      rememberSay(text, nowMs);
      if (!quiet) log(`会话 ${id.slice(-8)} 正忙（${agent.status}），先存着`);
      return { ok: false, pending: true, detail: '会话正忙' };
    }
    try {
      await agent.followup(buildMessage(frame(text)));
    } catch (error) {
      const detail = `followup 失败：${String(error?.message ?? error)}`;
      log(detail);
      return { ok: false, detail };
    }
    state.lastSpokeAt = nowMs;
    state.lastAskAt = nowMs;
    state.lastReportAt = nowMs;
    // 出队确认：这句真发出去了才销账（只销同文本那条，队列里别的话不动）
    ackPendingByKey(state, 'say', { text });
    save();
    try {
      if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session);
    } catch {
      /* 落盘确认失败无所谓 */
    }
    log(`已在 ${id.slice(-8)} 跟用户说：${text}`);
    return { ok: true };
  }

  // ── do 分支：直接开票（执行体在 lib/route.js，这里只接线） ────
  const openTicketRaw = createTicketOpener({
    tools: ctx.tools,
    findAgent,
    targetId,
    state,
    save,
    log,
    dryRun: cfg.dryRun,
    openTimeoutMs: cfg.openTimeoutMs,
  });

  async function openTicket(ticket, nowMs, options) {
    const opened = await openTicketRaw(ticket, nowMs, options);
    if (opened.ok) {
      state.lastAction = 'do';
      state.lastReportAt = nowMs;
      save();
    }
    return opened;
  }

  // ── 一拍：两段 + 三分支 ─────────────────────────────────────
  async function runRound(nowMs) {
    state.lastAction = '';
    if (!cfg.proposer.enabled || !cfg.judge.enabled) {
      log(`有一段被关掉了（proposer=${cfg.proposer.enabled} judge=${cfg.judge.enabled}），这一拍不跑`);
      return { ok: true, action: 'skipped' };
    }
    const proposal = await propose(nowMs);
    if (!proposal.ok) return { ok: false, error: proposal.error };
    if (!proposal.idea) {
      // 提议器自己说今天没话说：直接当无动作，不叫裁决器，省一次调用
      state.lastAction = 'silent';
      state.lastReason = proposal.why.slice(0, 200);
      log(`提议器没话说：${proposal.why || '（没写为什么）'}`);
      return { ok: true, action: 'silent' };
    }
    // 点子先落日志再叫裁决器：裁决器挂掉（超时/预算截断）时也能在日志里看到点子原文，
    // 否则日志里只剩「裁决器失败」，点子丢了。
    log(`点子：${proposal.idea}｜理由：${proposal.why}`);
    const judged = await judge(proposal, nowMs);
    if (!judged.ok) return { ok: false, error: judged.error };
    const decision = judged.decision;
    state.lastAction = decision.action;
    state.lastReason = (decision.reason || '').slice(0, 200);
    log(`裁决：${decision.action}｜${decision.reason || '（没写理由）'}`);

    // 三分支路由：silent 谁都不叫（这一支绝不产生任何消息，也不 followup 主会话）
    return routeDecision(decision, {
      ask: (text) => ask(text, nowMs),
      openTicket: (ticket) => openTicket(ticket, nowMs),
    });
  }

  /**
   * 每拍先把存着的补上（pending 重试不看整点和骰子，它已经决定过要不要动作了）。
   * 队列逐条消费：每拍只说队头那句、只开队头那张票，成功才出队；剩下的留给下一拍或补发盯梢。
   */
  async function retryPending(nowMs) {
    const { droppedSay, droppedTicket } = prunePending(state, nowMs, cfg.pendingTtlMinutes);
    if (droppedSay > 0 || droppedTicket > 0) {
      save();
      const parts = [];
      if (droppedSay > 0) parts.push(`话 ${droppedSay} 句`);
      if (droppedTicket > 0) parts.push(`票 ${droppedTicket} 张`);
      log(`存着的动作过期丢掉了：${parts.join('、')}（超过 ${cfg.pendingTtlMinutes} 分钟）`);
    }
    const say = pendingHead(state, 'say');
    if (say) {
      const sent = await ask(say.text, nowMs, { quiet: true });
      if (sent.ok) log(`存着的那句话补发出去了（队列里还剩 ${pendingCount(state, 'say')} 句）`);
    }
    const ticket = pendingHead(state, 'ticket');
    if (ticket) {
      const opened = await openTicket(ticket, nowMs, { quiet: true });
      if (opened.ok) log(`存着的那张票补开出去了（队列里还剩 ${pendingCount(state, 'ticket')} 张）`);
    }
  }

  function planNext(nowMs) {
    state.nextRunAt = nowMs + delayMs(new Date(nowMs), cfg);
  }

  let ticking = false;

  async function tick(nowMs = Date.now()) {
    if (!cfg.enabled || ticking) return;
    ticking = true;
    try {
      await retryPending(nowMs);
      if (state.retryAfterAt && nowMs < state.retryAfterAt) return;
      if (!state.nextRunAt || nowMs < state.nextRunAt) return;
      const now = new Date(nowMs);
      const window = speakingWindow(now, cfg);
      if (!window.ok) {
        planNext(nowMs);
        save();
        log(`跳过：${window.reason}，下一拍 ${fmt(state.nextRunAt)}`);
        return;
      }
      state.lastRunAt = nowMs;
      state.lastRollAt = nowMs;
      const roll = rollDice();
      const hitLine = Number(cfg.diceProbability) * 100;
      if (!hit(roll, hitLine)) {
        planNext(nowMs);
        save();
        log(`掷出 ${roll}（命中线 ${hitLine}）没中，下一拍 ${fmt(state.nextRunAt)}`);
        return;
      }
      log(`掷出 ${roll}（命中线 ${hitLine}）中了，开始想点子`);
      const result = await runRound(nowMs);
      planNext(nowMs);
      if (result.ok) {
        recordSuccess(state);
      } else {
        recordFailure(state, nowMs, { maxFailStreak: cfg.maxFailStreak, backoffMinutes: cfg.backoffMinutes });
        log(`这一拍失败：${result.error || result.detail || '未知'}｜连败 ${state.failStreak}${state.retryAfterAt ? `，推到 ${fmt(state.retryAfterAt)}` : ''}`);
      }
      save();
    } catch (error) {
      log(`定时器抛错：${String(error?.message ?? error)}`);
    } finally {
      ticking = false;
    }
  }

  /*
   * ── 手动催一拍（调试） ──────────────────────────────────────
   * 用户不想等骰子时，touch 一下 cfg.forceTriggerPath 就立刻跑一拍：
   * 跳骰子、跳安静/峰价、跳 nextRunAt 和连败推后；privateOnly、目标会话、互斥照旧。
   * 这一拍**不改** nextRunAt，正常排期该什么时候还什么时候。
   */
  async function forceTick(nowMs = Date.now()) {
    const id = targetId();
    const gate = checkForceGate({
      enabled: cfg.enabled,
      busy: ticking,
      privateOnly: cfg.privateOnly,
      pinned: String(cfg.targetSession || '').trim(),
      targetId: id,
      scope: scopeOf(id),
    });
    if (!gate.ok) {
      log(`[debug] 手动催拍被拒：${gate.reason}`);
      return { ok: false, error: gate.reason };
    }
    ticking = true;
    try {
      const nextBefore = state.nextRunAt;
      const result = await runForcedRound({
        nowMs,
        state,
        cfg,
        log,
        runRound,
        save,
      });
      // 正常拍是 planNext(nowMs) 重排；debug 拍刻意不动 nextRunAt
      if (state.nextRunAt !== nextBefore) {
        log(`[debug] nextRunAt 被改动了（${fmt(nextBefore)} → ${fmt(state.nextRunAt)}），debug 拍不该这样，改回去`);
        state.nextRunAt = nextBefore;
        save();
      }
      return result;
    } finally {
      ticking = false;
    }
  }

  // 15 秒看一眼触发文件；unref 掉，dispose 时连 interval 一起收
  ctx.effect(() => {
    const watcher = createForceWatcher({
      filePath: cfg.forceTriggerPath,
      intervalMs: cfg.forceIntervalMs,
      log,
      onForce: () => {
        void forceTick();
      },
    });
    watcher.start();
    log(`手动催拍已装好：touch ${cfg.forceTriggerPath} 就立刻跑一拍（每 ${Math.round(cfg.forceIntervalMs / 1000)} 秒看一眼）`);
    return () => watcher.stop();
  });

  /*
   * ── 存着的话/票：主会话一活就补发 ───────────────────────────
   * 为什么必须这样：重启后宿主的 sessions 表是空的，主会话的 agent 要等第一条
   * 入站消息才会由 getOrCreate → openSession 去 resume。在那之前
   * ctx.agents.get(sessionId) 查不到，followup 也没有出站路由能认的 record，
   * 所以开机自报只能先存着。tick 每分钟才兜一次；这里在主会话刚说话时盯 2 分钟，
   * 等它那一轮跑完变 idle 就立刻补，不用等下一分钟。
   */
  const flusher = createPendingFlusher({
    retryPending: (nowMs) => retryPending(nowMs),
    hasPending: () => hasPendingItems(state),
    log,
  });
  ctx.effect(() => () => flusher.stop());

  /*
   * ── 开机自报：起来后跟用户说一句「醒了」 ────────────────────
   * send 走 ask()，跟裁决器判 ask 发消息是同一条路（dryRun / privateOnly /
   * 目标会话不在活表就先存着，这些行为全都一样）。
   * 每进程只成功报一次：announcer 自己记状态，tick 那条路根本不会碰它。
   */
  const announcer = createAnnouncer({
    enabled: cfg.announceOnStart,
    send: (text) => ask(text, Date.now()),
    targetId,
    log,
    facts: () => ({ version: readVersion() }),
    // 整句可配：只换人称、改语气或整句重写都行，`{version}` 由 buildAnnounceText 填
    template: cfg.announceTemplate,
  });

  /*
   * 开机自报：起来后跟用户说一句「醒了」。
   *
   * 不再靠 `setTimeout(10 秒 ± 20%)` 猜时间：等 `internal/service`
   * 把 `agents` 服务挂上、且目标会话真在活表（findAgent 查得到、没在忙）就发。
   * 事件可能早于 ego 加载错过，也可能宿主压根不给这个服务，所以留一条有上限的兜底：
   * 到点还没发出去就按老路发一次并 warn，不许静默不发。
   * 发几次由 announce-gate 收口：成功或兜底试过一次就停，事件和兜底绝不各发一条。
   */
  ctx.effect(() => {
    if (!cfg.announceOnStart) {
      log('开机自报已关（announceOnStart = false）');
      return () => {};
    }
    const waitMs = announceWaitMs(cfg.announceDelayMs);
    // warn 同时走宿主日志和本地日志文件：只落文件排障得翻 log，只走 logger 又会漏
    const warnLine = (line) => {
      try {
        logger.warn?.(line);
      } catch {
        /* logger 挂了不影响发 */
      }
      log(line);
    };
    /** agents 服务在、目标会话在活表、且没在忙：ask 那条路能真发出去。 */
    const canSend = () => {
      const id = targetId();
      if (!id) return false;
      const agent = findAgent(id);
      return agent !== undefined && (agent.status === undefined || agent.status === 'idle');
    };
    const gate = createAnnounceGate({
      waitMs,
      canSend,
      trySend: () => announcer.announce(),
      log,
      warn: warnLine,
    });
    // 真实时机：agents 服务挂上就试一次。跟 hourly-driver 的 internal/service 写法同一条规矩：
    // 回调整只包 try/catch（events 的 emit 不兜错，冒出去会弄挂 apply），摘监听也包着。
    let offService = () => {};
    if (typeof ctx.on === 'function') {
      offService = ctx.on('internal/service', (name, value) => {
        try {
          if (name !== 'agents' || !value) return;
          gate.noteReady('agents 服务');
        } catch (error) {
          warnLine(
            `开机自报：internal/service 监听处理失败（name=${String(name)}）：${String(error?.message ?? error)}`,
          );
        }
      });
    }
    // 安装这一刻先探一次：ego 可能比 agents 晚加载，那条就绪事件已经错过了
    gate.noteReady('安装时探测');
    // 兜底：上限到了还没发出去，按老路发一次，并 warn 说明走的是兜底
    gate.startFallback();
    log(
      `开机自报已装好：等 agents 服务就绪且目标会话在活表就发；最多等 ${Math.round(waitMs / 1000)} 秒，` +
        '超时走兜底发一次（发不出去就存着，等主会话下一次活跃时补发）',
    );
    return () => {
      try {
        offService?.();
      } catch (error) {
        warnLine(`开机自报：摘 internal/service 监听失败：${String(error?.message ?? error)}`);
      }
      gate.dispose();
    };
  });

  // ── 学目标会话：收到用户的消息就记住它 ──────────────────────
  // ⚠ 三处都是坑：必须 { global: true }；消息在 event.data.message；会话 id 在 session.id。
  // 重启后事件总线有时还没接好，10 秒后再挂一次（实测会踩到）
  ctx.effect(() => {
    let dispose;
    const timer = setTimeout(() => {
      dispose = ctx.on(
        'session/event',
        (session, event) => {
          try {
            if (!event || event.type !== 'user/message') return;
            const message = event.data?.message ?? event.message ?? {};
            const source = event.data?.source ?? message.source ?? {};
            // 只认真的用户消息（我们自己塞的也是 user 角色，靠 source.kind 区分）
            if (source.kind !== 'user') return;
            const id = session?.id ?? session?.header?.id;
            if (!id) return;
            if (cfg.privateOnly && !isDirectScope(scopeOf(id))) {
              if (state.lastSkipped !== id) {
                state.lastSkipped = id;
                save();
                log(`跳过 ${String(id).slice(-8)}：不是私聊会话（${scopeOf(id) ?? '认不出'}）`);
              }
              return;
            }
            // 用户在私聊里说话了 = 主会话活过来了：先看一眼有没有存着的话/票要补发，
            // 再看要不要学目标会话（重启后第一次说话时两者会同时发生）
            flusher.schedule();
            if (id === state.targetSession) return;
            state.targetSession = id;
            save();
            log(`目标会话更新为 ${String(id).slice(-8)}`);
          } catch (error) {
            log(`学习监听抛错：${error?.message || error}`);
          }
        },
        { global: true },
      );
      log('学习监听已挂上（冷启动 10 秒后）');
    }, 10_000);
    if (typeof timer?.unref === 'function') timer.unref();
    return () => {
      clearTimeout(timer);
      if (typeof dispose === 'function') dispose();
    };
  });

  // 第一次启动：排上第一拍（整点 + 随机），别一上来就跑
  if (!state.nextRunAt || state.nextRunAt < Date.now() - 24 * 3600 * 1000) {
    planNext(Date.now());
    save();
  }

  // ── 整点主拍：dsh-timer 的 ego.hourly.tick 优先，拿不到就自己数分钟 ──
  // 旧主拍是「每分钟看一眼，nextRunAt 到了才真跑」；现在整点那一下由 tick 来，
  // 收到后按「整点 + 0~delayMaxMinutes 随机」算出这一小时几点醒，再等那一个点。
  // 降级（schedule 不在 / 注册被拒 / 服务中途消失 / tick 断流 3 拍）全回落到
  // 自己的 60 秒定时器，行为与旧主拍等价。见 lib/hourly-driver.js。
  // ⚠ 不用 ctx.setInterval（那要 inject 'timer'）；收尾交给 ctx.effect
  let pollHandle;
  let wakeHandle;
  let pollClosed = false;
  let lastTickKey = '';

  function stopPoll() {
    if (pollHandle === undefined) return;
    clearInterval(pollHandle);
    pollHandle = undefined;
  }

  function startPoll() {
    if (pollClosed || pollHandle !== undefined) return;
    pollHandle = setInterval(() => {
      // 每拍先探源，再判 nextRunAt：schedule 比 ego 晚 apply 时，靠这一眼在下一拍
      // 就切到整点 tick，而不是干等到 nextRunAt 那次真拍才 reconcile。
      hourlyDriver.onPoll();
    }, 60 * 1000);
    if (typeof pollHandle?.unref === 'function') pollHandle.unref();
  }

  function clearWake() {
    if (wakeHandle === undefined) return;
    clearTimeout(wakeHandle);
    wakeHandle = undefined;
  }

  /** 一支一次性延时：走到 tick 已经算好的那个点，不是轮询。 */
  function armWake(atMs, key) {
    clearWake();
    const delay = Math.max(0, atMs - Date.now());
    wakeHandle = setTimeout(() => {
      wakeHandle = undefined;
      log(`整点 tick${key ? ` ${key}` : ''} 到点，跑这一拍`);
      void tick();
    }, delay);
    if (typeof wakeHandle?.unref === 'function') wakeHandle.unref();
  }

  /** 收到一拍整点 tick：认周期去重，过期就按当前整点重排，再等到点。 */
  function hourlyTick(payload) {
    const key = tickPeriodKey(payload);
    if (!acceptTick(lastTickKey, key)) {
      log(`周期 ${key} 的 tick 重复/过期，不再排`);
      return;
    }
    if (key) lastTickKey = key;
    if (!cfg.enabled) return;
    const firedAt = Date.parse(String(payload?.firedAt ?? ''));
    const plan = wakeAtForTick({
      firedAt,
      nowMs: Date.now(),
      delayMaxMinutes: cfg.delayMaxMinutes,
    });
    // 旧主拍靠 nextRunAt 判「到点没有」，tick 这一路照样写它：降级回定时器时直接接上
    state.nextRunAt = Math.max(plan.at, Date.now());
    save();
    log(
      `整点 tick${key ? ` ${key}` : ''}：${plan.stale ? '过期一拍，跳到当前整点' : '按这一拍'}排到 ` +
        `${fmt(state.nextRunAt)} 醒`,
    );
    armWake(state.nextRunAt, key);
  }

  const hourlyDriver = createHourlyDriver({
    port: {
      pulse: (source, payload) => {
        if (source === 'tick') {
          hourlyTick(payload);
          return true;
        }
        // 探源由 driver.onPoll 在调这里之前做掉了（每拍一次，别在这再探一遍）
        void tick();
        return true;
      },
      drive: (source) => {
        if (source === 'tick') {
          stopPoll();
          clearWake();
        } else {
          startPoll();
        }
      },
    },
    events: () => probed(ctx, 'events'),
    schedule: () => probed(ctx, 'schedule'),
    info: log,
    warn: log,
  });

  // 自己的 60 秒定时器照旧由 ctx.effect 收尾；注册成功才由 driver 停掉它
  ctx.effect(() => {
    startPoll();
    return () => {
      pollClosed = true;
      stopPoll();
      clearWake();
    };
  });

  // 装载时就 reconcile 一次：schedule 比 ego 晚 apply 也没关系，tick 每拍会再探
  ctx.effect(() => {
    hourlyDriver.reconcile();
    return () => {
      pollClosed = true;
      hourlyDriver.dispose();
      clearWake();
    };
  });

  // schedule 服务一就绪就重挂规则，不用等下一拍的 60 秒轮询（也不等整点 tick）。
  // 监听器内部整只包了 try/catch：events 的 emit 不兜错，冒出去会弄挂 timer 的 apply。
  ctx.effect(() => {
    const off = attachServiceWatch(ctx, hourlyDriver, { warn: log });
    return () => off();
  });

  log(
    `已装好：整点后 0-${cfg.delayMaxMinutes} 分钟随机醒，命中线 ${cfg.diceProbability * 100}%，安静 ${cfg.quietStart}-${cfg.quietEnd} 点，` +
      `${cfg.offPeakOnly ? '只在谷价时段' : '不限峰谷'}${cfg.privateOnly ? '｜仅私聊' : ''}${cfg.dryRun ? '，试运行（不发消息不开票）' : ''}` +
      `｜手动催拍 ${cfg.forceTriggerPath}`,
  );

  // ── 给assistant自己看状态的只读工具 ──────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'ego_status',
      description:
        'Status of the dsh-ego proactive-thought plugin: when it will wake next, whether it is in quiet/peak hours, dice line, learned target session, recent verdict, pending say/ticket, fail streak. Use when asked 主动搭话 / 主动念头 / 会不会自己说话 / 自己开票.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', required: true },
            dryRun: { type: 'boolean', required: true },
            now: { type: 'string', required: true },
            peak: { type: 'boolean', required: true },
            quiet: { type: 'boolean', required: true },
            canRun: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
            target: { type: 'string', required: true },
            agentStatus: { type: 'string', required: true },
            nextRun: { type: 'string', required: true },
            diceLine: { type: 'string', required: true },
            lastAction: { type: 'string', required: true },
            lastReason: { type: 'string', required: true },
            pending: { type: 'string', required: true },
            failStreak: { type: 'string', required: true },
            config: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute() {
        const now = new Date();
        const nowMs = now.getTime();
        const window = speakingWindow(now, cfg);
        const id = targetId();
        const agent = findAgent(id);
        const next = nextWindow(now, cfg);
        const canRun =
          cfg.enabled && window.ok && (!state.retryAfterAt || nowMs >= state.retryAfterAt) && Boolean(state.nextRunAt) && state.nextRunAt <= nowMs;
        const sayHead = pendingHead(state, 'say');
        const ticketHead = pendingHead(state, 'ticket');
        const sayN = pendingCount(state, 'say');
        const ticketN = pendingCount(state, 'ticket');
        const pending = [
          sayN > 0 ? `一句没说出口的话 ×${sayN}（最早 ${fmt(sayHead.at)} 存的）` : '',
          ticketN > 0 ? `一张没开的票 ${ticketHead.callId ?? ''} ×${ticketN}（最早 ${fmt(ticketHead.at)} 存的）` : '',
        ].filter(Boolean).join('｜') || '没有';
        const configLine = `整点后 0-${cfg.delayMaxMinutes} 分钟随机｜命中线 ${cfg.diceProbability * 100}%｜安静 ${cfg.quietStart}-${cfg.quietEnd} 点｜${cfg.offPeakOnly ? '只在谷价' : '不限峰谷'}${cfg.privateOnly ? '｜仅私聊' : ''}${cfg.dryRun ? '｜试运行' : ''}｜提议器 ${cfg.proposer.provider}/${cfg.proposer.model}｜裁决器 ${cfg.judge.provider}/${cfg.judge.model}`;
        const text = [
          `主动念头：${cfg.enabled ? '开' : '关'}${cfg.dryRun ? '（试运行，不发消息不开票）' : ''}`,
          `现在 ${fmt(nowMs)}：${isPeak(now, cfg.holidays) ? '峰价' : '谷价'}｜${window.ok ? '能跑' : window.reason}`,
          `目标会话：${id ? `${id.slice(-8)}（${scopeOf(id) ?? '认不出'}）` : '还没学到（等用户在私聊里发一条消息）'}｜${agent ? `agent ${agent.status ?? '?'}` : '没找到活着的 agent'}`,
          `下一拍：${state.nextRunAt ? fmt(state.nextRunAt) : '还没排'}${state.retryAfterAt && state.retryAfterAt > nowMs ? `（连败推后到 ${fmt(state.retryAfterAt)}）` : ''}｜连败 ${state.failStreak}`,
          `最近裁决：${state.lastAction || '还没跑过'}${state.lastReason ? `｜${state.lastReason}` : ''}`,
          `存着的：${pending}`,
          `下一个能跑的窗口：${next ? fmt(next.getTime()) : '这几天都排不上'}`,
          configLine,
          `手动催一拍：touch ${cfg.forceTriggerPath}（每 ${Math.round(Number(cfg.forceIntervalMs) / 1000)} 秒看一眼，跳骰子跳时段，正常排期不动）`,
          canRun ? '结论：这一分钟它可能就醒了' : '结论：这一分钟它不会醒',
        ].join('\n');
        return {
          enabled: cfg.enabled,
          dryRun: cfg.dryRun,
          now: fmt(nowMs),
          peak: isPeak(now, cfg.holidays),
          quiet: !window.ok,
          canRun,
          reason: window.reason,
          target: id,
          agentStatus: agent ? String(agent.status ?? '?') : 'missing',
          nextRun: state.nextRunAt ? fmt(state.nextRunAt) : '',
          diceLine: `${cfg.diceProbability * 100}%`,
          lastAction: state.lastAction || '',
          lastReason: state.lastReason || '',
          pending,
          failStreak: String(state.failStreak ?? 0),
          config: configLine,
          text,
        };
      },
    }),
  );
}
