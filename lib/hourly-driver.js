/**
 * 整点主拍的驱动源：dsh-timer 的 `ego.hourly.tick` 优先，拿不到就自己数分钟。
 *
 * 背景：ego 的 60 秒主拍既是「整点+随机」的时钟，也是 pending 兜底
 * 的节拍。整点这一拍改由 dsh-timer 按规则 `ego.hourly`（cron `0 * * * *`，
 * `catchUp: skip`）发布 volatile tick，ego 订阅它来排这一小时几点醒。自己的
 * 60 秒定时器不能一刀删掉——注册没成功、timer 没挂、tick 中途断流，都得退回它，
 * 否则 ego 会静默地再也不醒。
 *
 * 四条降级路径，都不能让整点主拍停：
 *
 * - `schedule` 服务不在（dsh-timer 没挂、或还没 apply）：保留自己的定时器，每次
 *   巡检（= `onPoll`，60 秒轮询每一拍都调）再探一次——它中途出现就切过去。
 * - 注册被拒（EV-006：topic 没在 events 注册表里；BAD_RULE / DUP_RULE_ID 同理）：
 *   保留自己的定时器，冷却一段时间再试，别每拍刷一行 warn。
 * - 服务中途消失（events 或 schedule 被撤）：当场退回自己的定时器并 warn。
 * - tick 断流（dsh-timer 停了、events 没了、规则被撤了）：watchdog 按「三个周期
 *   没收到 tick」判死，退订 + 注销规则 + 恢复自己的定时器并 warn。宁可多跑一拍
 *   自己的定时器，也不能静默假装还在整点醒。
 *
 * 两把锁：
 *
 * - 拍子不并发：ego 的 `ticking` 那道闸是唯一的闸，定时器和订阅共用。
 * - 换源幂等：订阅只有一份（`subscription`）、规则只注册一次（`ruleRegistered`）、
 *   换源先停旧再起新（`port.drive`），重复 reconcile 不会变成两路同时驱动。
 */

/** dsh-timer 发 tick 用的事件名，也是本文件订阅/注册的名字。 */
export const HOURLY_TOPIC = 'ego.hourly.tick';
/** 规则 id：`schedule.register` 里全局唯一，注销时按它撤。 */
export const HOURLY_RULE_ID = 'ego.hourly';
/** 订阅者 id：dsh-events 的投递游标按它记，重复订阅也只会有一份。 */
export const HOURLY_SUBSCRIBER_ID = 'dsh-ego.hourly';
/** 噪声最小的整点规则：每小时 0 分。错过就跳（凌晨不补）。 */
export const HOURLY_CRON = '0 * * * *';
/** 一拍就是一个小时。 */
const PERIOD_MS = 60 * 60 * 1000;

/**
 * 事件类型注册项。volatile：tick 是「到点了」的信号，不是业务数据，不该在
 * 事件表里留行，也不需要重放。
 */
export const HOURLY_EVENT_DEF = Object.freeze({
  name: HOURLY_TOPIC,
  version: 1,
  durability: 'volatile',
  payloadSchema: (payload) => {
    const tick = payload;
    return (
      typeof tick?.name === 'string' &&
      typeof tick?.firedAt === 'string' &&
      typeof tick?.periodKey === 'string'
    );
  },
});

/** 真时钟：watchdog 用；interval 的句柄 unref 掉，别拽着进程不放。 */
export const realClock = {
  now: () => new Date(),
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    if (typeof handle?.unref === 'function') handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle);
  },
};

/** tick 断流判定：这么多拍没来就认死。 */
const STALL_FACTOR = 3;
/**
 * 降级后路的快档：`internal/service` 事件一次都没收到时，watchdog 每 10 分钟
 * 睁一次眼（阈值也按 10 分钟算），别傻等 3 个整点。收到过事件就回慢档。
 */
const QUICK_WATCHDOG_MS = 10 * 60 * 1000;
/** 注册/订阅失败后的冷却：半小时，别每小时都撞一次同一堵墙。 */
const RETRY_MS = 30 * 60 * 1000;

/**
 * 「没有 schedule」分三种原因说，别都写成「dsh-timer 未挂」把排障带错方向：
 * 尚未就绪 / 已就绪但本插件没拿到句柄 / 规则被撤。文案跟其它插件逐字一致。
 */
const SCHEDULE_ABSENT = Object.freeze({
  notReady: 'schedule 服务尚未就绪（dsh-timer 未挂或还没 apply）',
  noHandle: 'schedule 服务已就绪过，但本插件没拿到句柄（inject/ctx.get 未生效，或服务正在重载）',
  ruleRevoked: 'schedule 规则被撤（曾注册成功，现不在规则表里）',
});

function scheduleAbsentReason(seenInstance) {
  return seenInstance ? SCHEDULE_ABSENT.noHandle : SCHEDULE_ABSENT.notReady;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error) {
  const code = error?.code;
  return typeof code === 'string' && code ? code : 'ERR';
}

/**
 * @param {{
 *   port: { pulse: (source: 'interval'|'tick', payload?: unknown) => unknown, drive: (source: 'interval'|'tick') => void },
 *   events: () => object|undefined,
 *   schedule: () => object|undefined,
 *   periodMs?: number,
 *   clock?: typeof realClock,
 *   info?: (message: string) => void,
 *   warn?: (message: string) => void,
 * }} options
 */
export function createHourlyDriver(options) {
  const { port, events, schedule } = options;
  const periodMs = Number(options.periodMs) > 0 ? Number(options.periodMs) : PERIOD_MS;
  const clock = options.clock ?? realClock;
  const info = options.info ?? (() => {});
  const warn = options.warn ?? (() => {});
  const stallMs = periodMs * STALL_FACTOR;

  let mode = 'interval';
  let subscription;
  let ruleRegistered = false;
  let lastTickAt = 0;
  let retryAt = 0;
  /** 上次看到的 schedule 服务实例：换实例等于规则全丢，得在新实例上重挂。 */
  let scheduleSeen;
  /** 「schedule 不在」只播报一次，服务出现过再消失时重新播报。 */
  let absentAnnounced = false;
  /** 「events 不在」同理：不刷屏，服务出现过再消失时重新播报。 */
  let eventsAnnounced = false;
  let watchdog;
  let stopped = false;
  /**
   * 降级标记：`internal/service` 里收到过 schedule 事件没有。
   *
   * 正常路径靠事件驱动重挂规则；收不到事件时（宿主版本不吃这个事件、root 不同）
   * 只能靠 watchdog 睁眼，所以它一假就把巡检收紧到 10 分钟，并顺手查一次规则。
   */
  let serviceEventSeen = false;
  /** 监听挂没挂：没挂的时候（单独用 driver）不该按「a 方案失效」收紧 watchdog。 */
  let watchAttached = false;

  function now() {
    return clock.now().getTime();
  }

  function dropSubscription() {
    const sub = subscription;
    if (!sub) return false;
    subscription = undefined;
    try {
      sub.stop?.();
    } catch (error) {
      warn(`[ego] 退订 ${HOURLY_TOPIC} 失败：${messageOf(error)}`);
    }
    return true;
  }

  function dropRule() {
    if (!ruleRegistered) return;
    ruleRegistered = false;
    const service = schedule();
    if (!service) return;
    try {
      service.unregister(HOURLY_RULE_ID);
    } catch (error) {
      warn(`[ego] 注销规则 ${HOURLY_RULE_ID} 失败：${messageOf(error)}`);
    }
  }

  function stopWatchdog() {
    if (watchdog === undefined) return;
    clock.clearInterval(watchdog);
    watchdog = undefined;
  }

  function startWatchdog() {
    stopWatchdog();
    // 睁眼间隔按降级标记定：监听着、事件一次没来过 → 10 分钟一次（阈值也收紧）；
    // 收到过事件、或根本没挂监听 → 「每整点睁眼、3 拍判死」。快档只读本地变量，开销可忽略。
    const quick = watchAttached && !serviceEventSeen;
    const tickEvery = quick ? Math.min(QUICK_WATCHDOG_MS, periodMs) : periodMs;
    watchdog = clock.setInterval(() => {
      if (stopped || mode !== 'tick') return;
      const idle = now() - lastTickAt;
      if (quick) {
        // a 方案的后路：监听挂了但事件一次没来过，顺手看一眼规则还在不在，丢了就地重挂。
        // 重挂成功说明服务还在、tick 还会来，把表重新起算，别当场判死。
        let rearmed = false;
        try {
          rearmed = probeRule();
        } catch (error) {
          warn(`[ego] 巡检探规则抛错：${messageOf(error)}`);
        }
        if (rearmed) {
          lastTickAt = now();
          return;
        }
        if (idle < Math.min(QUICK_WATCHDOG_MS, periodMs)) return;
      } else if (idle < stallMs) {
        return;
      }
      // 断流不是「少跑一拍」而是「再也不会醒」：必须当场把驱动源换回来。
      fallback(`[ego] ${HOURLY_TOPIC} 断流：${Math.round(idle / 60_000)} 分钟没收到 tick`);
    }, tickEvery);
  }

  /**
   * 后路探针：`schedule.list()`/`listRules()` 哪个能用用哪个，查自己的规则还在不在。
   * 没有列表接口就当它在（不多事）；查不到才清 `ruleRegistered` 让 reconcile 重挂。
   */
  function probeRule() {
    if (mode !== 'tick' || stopped) return false;
    const service = schedule();
    if (!service) return false;
    const read = typeof service.list === 'function' ? service.list : service.listRules;
    if (typeof read !== 'function') return false;
    let rules;
    try {
      rules = read.call(service);
    } catch (error) {
      warn(`[ego] 列规则失败（${codeOf(error)}）：${messageOf(error)}`);
      return false;
    }
    if (!Array.isArray(rules)) return false;
    if (rules.some((rule) => rule?.id === HOURLY_RULE_ID)) return false;
    ruleRegistered = false;
    reconcile();
    return ruleRegistered;
  }

  function switchToTick() {
    mode = 'tick';
    lastTickAt = now();
    port.drive('tick');
    startWatchdog();
    info(
      `[ego] 整点主拍由 ${HOURLY_TOPIC} 驱动（规则 ${HOURLY_RULE_ID}，cron ${HOURLY_CRON}，catchUp=skip），自己的 60 秒定时器已停`,
    );
  }

  /** 降级：退回自己的定时器，并说明原因。只在 tick 模式下有意义。 */
  function fallback(reason) {
    if (mode !== 'tick' || stopped) return;
    stopWatchdog();
    dropSubscription();
    dropRule();
    mode = 'interval';
    retryAt = now() + RETRY_MS;
    port.drive('interval');
    warn(`${reason}，ego 恢复自己的 60 秒定时器`);
  }

  function ensureSubscription(service) {
    if (subscription) return true;
    try {
      service.defineEvent(HOURLY_EVENT_DEF);
    } catch (error) {
      // 重复注册（热重载、上一份 fiber 已注册过）不算失败：注册表里查得到就行。
      if (service.registry?.get?.(HOURLY_TOPIC) === undefined) {
        warn(
          `[ego] 注册事件类型 ${HOURLY_TOPIC} 失败（${codeOf(error)}）：${messageOf(error)}，ego 仍由自己的 60 秒定时器驱动`,
        );
        return false;
      }
    }
    try {
      const sub = service.subscribe(
        HOURLY_TOPIC,
        (event) => {
          handleTick(event?.payload);
          return undefined;
        },
        { subscriberId: HOURLY_SUBSCRIBER_ID, replay: { mode: 'none' } },
      );
      if (!sub || typeof sub.stop !== 'function') {
        warn(`[ego] 订阅 ${HOURLY_TOPIC} 没拿到 stop()，ego 仍由自己的 60 秒定时器驱动`);
        return false;
      }
      subscription = sub;
      info(`[ego] 已订阅 ${HOURLY_TOPIC}（volatile，不落事件表）`);
      return true;
    } catch (error) {
      warn(`[ego] 订阅 ${HOURLY_TOPIC} 失败：${messageOf(error)}，ego 仍由自己的 60 秒定时器驱动`);
      return false;
    }
  }

  function registerRule(service, announce) {
    try {
      service.register({
        id: HOURLY_RULE_ID,
        cron: HOURLY_CRON,
        topic: HOURLY_TOPIC,
        catchUp: 'skip',
      });
      ruleRegistered = true;
      if (typeof announce === 'function') announce();
      return true;
    } catch (error) {
      ruleRegistered = false;
      retryAt = now() + RETRY_MS;
      warn(
        `[ego] 注册规则 ${HOURLY_RULE_ID} 失败（${codeOf(error)}）：${messageOf(error)}，ego 仍由自己的 60 秒定时器驱动`,
      );
      return false;
    }
  }

  function handleTick(payload) {
    if (stopped) return;
    // 先记时间：闸掉的那一拍也算「流还活着」，否则 watchdog 会误判断流。
    lastTickAt = now();
    try {
      port.pulse('tick', payload);
    } catch (error) {
      warn(`[ego] 处理 ${HOURLY_TOPIC} 抛错：${messageOf(error)}`);
    }
    reconcile();
  }

  function reconcile() {
    if (stopped) return;

    const eventsService = events();
    if (!eventsService) {
      const had = dropSubscription();
      if (mode === 'tick') {
        fallback('[ego] events 服务不在了');
      } else if (!eventsAnnounced) {
        eventsAnnounced = true;
        info('[ego] 没有 events 服务，ego 由自己的 60 秒定时器驱动（tick 订阅等它出现再挂）');
      } else if (had) {
        warn('[ego] events 服务不在了，ego 仍由自己的 60 秒定时器驱动');
      }
      return;
    }
    eventsAnnounced = false;

    if (!ensureSubscription(eventsService)) return;

    const scheduleService = schedule();
    if (!scheduleService) {
      if (mode === 'tick') {
        fallback('[ego] schedule 服务不在了');
      } else if (!absentAnnounced) {
        absentAnnounced = true;
        warn(`[ego] ${scheduleAbsentReason(scheduleSeen !== undefined)}，ego 由自己的 60 秒定时器驱动，等服务出现再切换`);
      }
      return;
    }

    if (scheduleService !== scheduleSeen) {
      // 新实例（装上、重启、热重载）：旧规则跟着旧实例没了，得重挂。
      if (scheduleSeen !== undefined) info('[ego] schedule 服务换了实例，规则在新实例上重挂');
      scheduleSeen = scheduleService;
      ruleRegistered = false;
      retryAt = 0;
      absentAnnounced = false;
    }

    if (mode === 'tick' && ruleRegistered) return;

    if (now() < retryAt) return;

    if (mode === 'tick') {
      // 已经在 tick 模式但规则丢了（比如被谁 unregister 掉）：重挂，不换源。
      info(`[ego] ${SCHEDULE_ABSENT.ruleRevoked}，重挂规则 ${HOURLY_RULE_ID}`);
      registerRule(scheduleService, () => info(`[ego] 规则 ${HOURLY_RULE_ID} 已重挂`));
      return;
    }

    registerRule(scheduleService, () => switchToTick());
  }

  /** 监听已挂（attachServiceWatch 调）：没收到事件时 watchdog 才收快档。 */
  function markServiceWatch() {
    if (watchAttached) return;
    watchAttached = true;
    // 监听挂上之前 watchdog 可能已经按慢档起了：立刻按快档重起，别等一个整点。
    if (watchdog !== undefined) startWatchdog();
  }

  /**
   * `internal/service` 事件入口：schedule 就绪/销毁。
   *
   * 就绪（value 非空）返回 true，调用方接着 reconcile——路径和「每拍轮询探到
   * 服务」完全一样，换实例重挂的判定也复用 scheduleSeen。
   *
   * 销毁（value 为空）只清缓存标记：别在这里 reconcile，那会走 fallback 起
   * 60 秒轮询，服务马上要再来，纯属无意义往返加噪音；等真断流由 watchdog 判死。
   *
   * @param {string} name
   * @param {unknown} value
   * @returns {boolean} 是否该接着 reconcile
   */
  function noteServiceEvent(name, value) {
    if (name !== 'schedule') return false;
    const firstSeen = !serviceEventSeen;
    serviceEventSeen = true;
    // 标记翻真后 watchdog 该回慢档：重起一次，别让它还按 10 分钟空转。
    if (firstSeen && watchdog !== undefined) startWatchdog();
    if (value) return true;
    scheduleSeen = undefined;
    ruleRegistered = false;
    absentAnnounced = false;
    return false;
  }

  return {
    reconcile,
    noteServiceEvent,
    markServiceWatch,
    /**
     * 60 秒轮询的每一拍：先探源，再决定这一拍要不要真跑。
     *
     * 为什么必须先探：ego 可能比 dsh-timer 先 apply，那会儿 schedule 还没提供，
     * 手上只有一个 60 秒定时器。旧写法只在收到 tick（handleTick）时才 reconcile，
     * 而 tick 恰恰要靠 schedule 注册规则才会来——没有 tick 就永远等不到 tick。
     * 所以每一拍都探一次：服务出现、注册冷却到期、规则被撤，都在下一拍补上。
     *
     * 开销要可忽略：reconcile 只读 ctx 上的服务句柄和本地几个标记，已经订阅、
     * 已经注册时只是几次比较；不开库、不发事件。
     *
     * 切到 tick 后旧定时器会被 port.drive('tick') 停掉，切换那一拍不再跑真拍，
     * 排期交给整点 tick 去算。
     */
    onPoll() {
      if (stopped) return;
      reconcile();
      if (mode === 'tick' || stopped) return;
      port.pulse('interval');
    },
    tick(payload) {
      handleTick(payload);
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      stopWatchdog();
      dropSubscription();
      dropRule();
      mode = 'interval';
    },
    mode: () => mode,
    status: () => ({
      mode,
      subscribed: subscription !== undefined,
      registered: ruleRegistered,
      lastTickAt,
      serviceEventSeen,
      watchAttached,
    }),
  };
}

/**
 * 挂 `internal/service` 监听：schedule 就绪就重挂规则，不用等下一拍轮询。
 *
 * ⚠ 回调整只包 try/catch，这条是硬要求：dsh-events 的 emit 是
 * `dispatch(...).map(cb => cb(...args))`，没有 try/catch，监听器抛错会冒到
 * timer 的 provide/effect，可能把 timer 的 apply 弄挂。catch 里只 warn，绝不 rethrow。
 *
 * 不加 `{ global: true }`：同 root 同 isolate 就能收到（实测）。
 *
 * @param {{ on: (event: string, listener: (...args: any[]) => unknown) => () => void }} ctx
 * @param {{ noteServiceEvent: (name: string, value: unknown) => boolean, reconcile: () => void }} driver
 * @param {{ warn?: (message: string) => void }} [options]
 * @returns {() => void} 摘监听
 */
export function attachServiceWatch(ctx, driver, options = {}) {
  const warn = options.warn ?? (() => {});
  if (typeof driver.markServiceWatch === 'function') driver.markServiceWatch();
  const off = ctx.on('internal/service', (name, value) => {
    try {
      if (name !== 'schedule') return;
      if (!driver.noteServiceEvent(name, value)) return;
      driver.reconcile();
    } catch (error) {
      warn(`[ego] internal/service 监听处理失败（name=${String(name)}）：${messageOf(error)}`);
    }
  });
  return () => {
    try {
      off?.();
    } catch (error) {
      warn(`[ego] 摘 internal/service 监听失败：${messageOf(error)}`);
    }
  };
}
