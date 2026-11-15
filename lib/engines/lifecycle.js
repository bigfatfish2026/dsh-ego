/**
 * 生命周期接线：手动催拍文件、待发补发、开机自报、目标会话学习、
 * 整点主拍/60 秒兜底、安全轮询、以及 ego_tick / ego_status 两个工具。
 *
 * 从 lib/index.js 的 apply 闭包里整段搬出来（行为零改动）；这里只负责
 * 把现成对象接上宿主 ctx，不自己造 state / 不自己读盘。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { isPeak, nextWindow, speakingWindow } from '../window.js';
import { hasPendingItems, hasPendingText, pendingCount, pendingHead } from '../pending-queue.js';
import { createForceWatcher } from '../force.js';
import { EGO_TICK_DESCRIPTION, createEgoTickTool } from '../ego-tick.js';
import { isDirectScope } from '../scope.js';
import { announceWaitMs, createAnnouncer } from '../announce.js';
import { createAnnounceGate } from '../announce-gate.js';
import { announceRetryWindowMs, createAnnounceRetry } from '../announce-retry.js';
import { createPendingFlusher } from '../flush.js';
import { acceptTick, cronForInterval, periodMsFor, tickPeriodKey, wakeAtForTick } from '../hourly.js';
import { attachServiceWatch, createHourlyDriver } from '../hourly-driver.js';
import { createSafetyPoll } from '../safety-poll.js';

/**
 * @param {object} deps
 * @param {object} deps.cfg 配置
 * @param {object} deps.state 插件内存 state
 * @param {Function} deps.save 落盘
 * @param {Function} deps.log 单行日志
 * @param {object} deps.logger 宿主 logger
 * @param {object} deps.ctx 宿主 ctx
 * @param {object} deps.round 一拍引擎
 * @param {Function} deps.scopeOf 会话 → 群聊/私聊
 * @param {Function} deps.fmt 时间格式化
 * @param {Function} deps.readVersion 版本探测
 * @param {Function} deps.probed 服务探测
 */
export function createLifecycle(deps) {
  const { cfg, state, save, log, logger, ctx, round, scopeOf, fmt, readVersion, probed } = deps;

  ctx.effect(() => {
    const watcher = createForceWatcher({
      filePath: cfg.forceTriggerPath,
      intervalMs: cfg.forceIntervalMs,
      log,
      onForce: () => {
        void round.manualTick();
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
    retryPending: (nowMs) => round.retryPending(nowMs),
    hasPending: () => hasPendingItems(state),
    log,
  });
  ctx.effect(() => () => flusher.stop());

  /*
   * ── 开机自报：起来后跟用户说一句「醒了」 ────────────────────
   * send 走 ask()，跟终审判 ask 发消息是同一条路（dryRun / privateOnly /
   * 目标会话不在活表就先存着，这些行为全都一样）。
   * 每进程只成功报一次：announcer 自己记状态，tick 那条路根本不会碰它。
   */
  const announcer = createAnnouncer({
    enabled: cfg.announceOnStart,
    send: (text) => round.ask(text, Date.now()),
    targetId: round.targetId,
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
   *
   * 补过的坑：兜底到点时会话可能只差 1 秒才进活表（warmup 写活表），
   * 那时 ask 只把话排进 pendingSayQueue；以前这里就收口了，下一次重试是整点那一拍，
   * 而 30 分钟 TTL 撑不到 60 分钟后的整点，话就被清掉。现在兜底带 queued 结果回来，
   * 这里开一段 announceRetryWindowMs 的盯梢：会话一进活表就走 retryPending 补发一次，
   * 补发成功 ask 会 ack 掉队列条目，所以只会发一次，不会跟「已发」状态打架。
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
      const id = round.targetId();
      if (!id) return false;
      const agent = round.findAgent(id);
      return agent !== undefined && (agent.status === undefined || agent.status === 'idle');
    };
    /**
     * 兜底发不出去、话已经真在队列里：开一段有上限的盯梢。
     * 盯的是队列（hasPendingText）而不是 announcer.sent：补发走 retryPending，
     * 发成功 ask 会 ack 掉队列条目，队列空了就收口，不会补第二次。
     */
    let retryWatch;
    const onQueued = (result) => {
      const text = String(result?.text ?? '');
      retryWatch?.dispose();
      retryWatch = createAnnounceRetry({
        windowMs: announceRetryWindowMs(cfg.announceRetryWindowMs),
        canSend,
        hasPending: () => (text ? hasPendingText(state, 'say', text) : false),
        retryPending: (nowMs) => round.retryPending(nowMs),
        log,
        warn: warnLine,
      });
      retryWatch.start();
    };
    const gate = createAnnounceGate({
      waitMs,
      canSend,
      trySend: () => announcer.announce(),
      onQueued,
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
    const retryWindowMs = announceRetryWindowMs(cfg.announceRetryWindowMs);
    log(
      `开机自报已装好：等 agents 服务就绪且目标会话在活表就发；最多等 ${Math.round(waitMs / 1000)} 秒，` +
        `超时走兜底发一次（发不出去就排进待发队列，兜底后 ${Math.round(retryWindowMs / 1000)} 秒内` +
        '会话一进活表就补发；再不行就存着，等主会话下一次活跃时补发）',
    );
    return () => {
      try {
        offService?.();
      } catch (error) {
        warnLine(`开机自报：摘 internal/service 监听失败：${String(error?.message ?? error)}`);
      }
      retryWatch?.dispose();
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
    round.planNext(Date.now());
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
      log(`周期 tick${key ? ` ${key}` : ''} 到点，跑这一拍`);
      void round.tick();
    }, delay);
    if (typeof wakeHandle?.unref === 'function') wakeHandle.unref();
  }

  /** 收到一拍整点 tick：认周期去重，过期就按当前整点重排，再等到点。 */
  function hourlyTick(payload) {
    const key = tickPeriodKey(payload, cfg.tickIntervalMinutes);
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
      periodMinutes: cfg.tickIntervalMinutes,
    });
    // 旧主拍靠 nextRunAt 判「到点没有」，tick 这一路照样写它：降级回定时器时直接接上
    state.nextRunAt = Math.max(plan.at, Date.now());
    save();
    log(
      `周期 tick${key ? ` ${key}` : ''}：${plan.stale ? '过期一拍，跳到当前周期起点' : '按这一拍'}排到 ` +
        `${fmt(state.nextRunAt)} 醒`,
    );
    armWake(state.nextRunAt, key);
  }

  const hourlyDriver = createHourlyDriver({
    // 周期可配（ego.tickIntervalMinutes）：默认 60 → cron '0 * * * *'、periodMs 3600000，
    // 与改造前逐字一致；10 → '*/10 * * * *'、600000，watchdog 的断流线也跟着收窄
    cron: cronForInterval(cfg.tickIntervalMinutes),
    periodMs: periodMsFor(cfg.tickIntervalMinutes),
    port: {
      pulse: (source, payload) => {
        if (source === 'tick') {
          hourlyTick(payload);
          return true;
        }
        // 探源由 driver.onPoll 在调这里之前做掉了（每拍一次，别在这再探一遍）
        void round.tick();
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

  /*
   * 热加载/重启后按已有排期重排唤醒。
   *
   * 坑（真机实测）：`dsh_hot_reload` 是「撤旧 fiber → 挂新 fiber」，旧实例
   * dispose 时 ctx.effect 的收尾把 armWake 的一次性 timer 清了；新实例 apply 时
   * nextRunAt 还在未来（13:00 热加载、13:02:21 那一拍），既不满足「第一次启动才
   * planNext」，也没人调 armWake，而 60 秒主拍在切到 tick 模式时已被停掉——于是这一拍
   * 静默丢掉，一直空到 14:00 的整点 tick 才重排回来。
   *
   * 所以 apply 收尾按已有排期重新 arm 一次。必须排在 reconcile 之后：切到 tick 模式时
   * port.drive('tick') 会 clearWake，先 arm 也会被它清掉。
   */
  function rearmFromState() {
    if (!cfg.enabled) return;
    const nowMs = Date.now();
    const at = Number(state.nextRunAt);
    if (!Number.isFinite(at) || at <= 0 || at < nowMs - 24 * 3600 * 1000) {
      // 没排期或排期太旧：跟第一次启动一样重排，别沿用一张过期的表
      round.planNext(nowMs);
      save();
    }
    if (state.nextRunAt > Date.now()) {
      armWake(state.nextRunAt, '启动重排');
      log(`按已有排期重排唤醒：${fmt(state.nextRunAt)} 醒（热加载/重启后下一拍接着走）`);
      return;
    }
    log(`下一拍 ${fmt(state.nextRunAt)} 已经过期，交给兜底轮询补跑`);
  }
  ctx.effect(() => {
    rearmFromState();
    return () => {};
  });

  /*
   * 兜底轮询：每 25 秒看一眼 nextRunAt，过期且没在跑就补一拍。
   * 跟驱动源无关（60 秒主拍切到 tick 时会被停掉、watchdog 一小时才睁一次眼都不影响它），
   * 只读内存里的三个字段，不读盘、不碰服务句柄。见 lib/safety-poll.js。
   */
  const safetyPoll = createSafetyPoll({
    isEnabled: () => cfg.enabled,
    isBusy: () => round.isBusy(),
    nextRunAt: () => state.nextRunAt,
    retryAfterAt: () => state.retryAfterAt,
    onDue: () => {
      void round.tick();
    },
    log,
  });
  ctx.effect(() => {
    safetyPoll.start();
    return () => safetyPoll.stop();
  });

  // schedule 服务一就绪就重挂规则，不用等下一拍的 60 秒轮询（也不等整点 tick）。
  // 监听器内部整只包了 try/catch：events 的 emit 不兜错，冒出去会弄挂 timer 的 apply。
  ctx.effect(() => {
    const off = attachServiceWatch(ctx, hourlyDriver, { warn: log });
    return () => off();
  });

  log(
    `已装好：每 ${cfg.tickIntervalMinutes} 分钟一拍，周期起点后 0-${cfg.delayMaxMinutes} 分钟随机醒，命中线 ${cfg.diceProbability * 100}%，安静 ${cfg.quietStart}-${cfg.quietEnd} 点，` +
      `${cfg.offPeakOnly ? '只在谷价时段' : '不限峰谷'}${cfg.privateOnly ? '｜仅私聊' : ''}${cfg.dryRun ? '，试运行（不发消息不开票）' : ''}` +
      `｜票台闸 ${cfg.skipWhenTicketsBusy === false ? '关' : '开'}｜手动催拍 ${cfg.forceTriggerPath}`,
  );

  // ── 立刻催一拍（主会话改完代码验效果用，不是查询） ────────────
  const egoTickTool = createEgoTickTool({
    manualTick: round.manualTick,
    log,
    isBusy: () => round.isBusy(),
  });
  ctx.tools.register(
    defineTool({
      name: 'ego_tick',
      description: EGO_TICK_DESCRIPTION,
      parameters: {
        reason: { type: 'string', description: '可选：为什么催这一拍，写进日志；不填记「未写」' },
        dryRun: {
          type: 'boolean',
          description: '可选：true 强制演练（不发消息不开票），false 强制真跑；不填沿用配置',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        return egoTickTool(args ?? {});
      },
    }),
  );

  // ── 给assistant自己看状态的只读工具 ──────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'ego_status',
      description:
        'Status of the dsh-ego proactive-thought plugin: when it will wake next, whether it is in quiet/peak hours, dice line, learned target session, recent verdict, pending say/ticket requests, fail streak. Use when asked 主动搭话 / 主动念头 / 会不会自己说话 / 自己开票.',
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
        const id = round.targetId();
        const agent = round.findAgent(id);
        const next = nextWindow(now, cfg);
        const canRun =
          cfg.enabled && window.ok && (!state.retryAfterAt || nowMs >= state.retryAfterAt) && Boolean(state.nextRunAt) && state.nextRunAt <= nowMs;
        const sayHead = pendingHead(state, 'say');
        const ticketHead = pendingHead(state, 'ticket');
        const sayN = pendingCount(state, 'say');
        const ticketN = pendingCount(state, 'ticket');
        const pending = [
          sayN > 0 ? `一句没说出口的话 ×${sayN}（最早 ${fmt(sayHead.at)} 存的）` : '',
          ticketN > 0 ? `一份没提上去的开票申请 ${ticketHead.callId ?? ''} ×${ticketN}（最早 ${fmt(ticketHead.at)} 存的）` : '',
        ].filter(Boolean).join('｜') || '没有';
        const configLine = `每 ${cfg.tickIntervalMinutes} 分钟一拍（周期起点后 0-${cfg.delayMaxMinutes} 分钟随机）｜命中线 ${cfg.diceProbability * 100}%｜安静 ${cfg.quietStart}-${cfg.quietEnd} 点｜${cfg.offPeakOnly ? '只在谷价' : '不限峰谷'}${cfg.privateOnly ? '｜仅私聊' : ''}${cfg.dryRun ? '｜试运行' : ''}｜票台闸 ${cfg.skipWhenTicketsBusy === false ? '关' : '开'}（已轮空 ${Number(state.busySkips) || 0} 次）｜提议器 ${cfg.proposer.provider}/${cfg.proposer.model}｜终审 ${cfg.judge.provider}/${cfg.judge.model}`;
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
