/**
 * 开机自报的「等就绪」闸门。
 *
 * 早先是 `setTimeout(10 秒 ± 20%)` 猜时间：猜早了宿主还没把主会话预热进活表，
 * 话只能进 pending；猜晚了就是白等。现在改成等真实信号——
 * ego 的 apply 里挂 `internal/service`，`agents` 服务挂上就试一次；目标会话
 * 是否真在活表交给 `canSend()` 判。宿主哪天没有这个服务（或服务早于 ego 就绪、
 * 事件已错过），兜底 timer 到点按老路发一次并 warn 一条，绝不静默不发。
 *
 * 语义就四条：
 *   · 只报一次：成功（ok）或跳过（skipped，例如已报过 / 开关关了）即收口；
 *   · 事件和兜底不各发一条：兜底只在没成功时补一次，发完同样收口；
 *   · 兜底发不出去但话已经排进 pendingSayQueue（queued）：收口前把这件事交给
 *     `onQueued`，由它开一段有上限的「会话就绪就补发」盯梢；收口本身不变，
 *     这里绝不会再发第二条，补发只走队列（发成功会 ack 掉那条）；
 *   · 任何一步抛错都不许冒出去（冒到 ctx.effect 里会把插件弄挂），只 warn。
 */

/** 兜底等待上限：沿用老的 10 秒量级，宿主实在不给信号就按这个等。 */
export const DEFAULT_ANNOUNCE_WAIT_MS = 10_000;

/** 兜底到点那一刻事件那条还在发：隔这么久再看一眼，别直接把兜底丢了。 */
export const FALLBACK_RECHECK_MS = 1_000;

/**
 * @param {{
 *   waitMs?: number,
 *   canSend?: () => boolean,
 *   trySend: () => Promise<{ ok?: boolean, skipped?: boolean, queued?: boolean, pending?: boolean, reason?: string, detail?: string, text?: string }>,
 *   onQueued?: (result: object) => void,
 *   log?: (line: string) => void,
 *   warn?: (line: string) => void,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (timer: any) => void,
 * }} options
 */
export function createAnnounceGate(options = {}) {
  const {
    waitMs = DEFAULT_ANNOUNCE_WAIT_MS,
    canSend = () => true,
    trySend,
    onQueued = () => {},
    log = () => {},
    warn = () => {},
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
  } = options;

  if (typeof trySend !== 'function') {
    throw new TypeError('createAnnounceGate 需要 trySend 函数');
  }

  /** 已经收口：发出去过，或兜底试过一次。收口后事件和 timer 都不再动。 */
  let settled = false;
  /** 正在发：事件可能连来两次（服务就绪 + 安装探测），别并发发两条。 */
  let running = false;
  let disposed = false;
  let timer;
  let fallbacks = 0;

  function stopTimer() {
    if (timer === undefined) return;
    try {
      clearTimer(timer);
    } catch {
      /* 清不掉也不影响下一次 */
    }
    timer = undefined;
  }

  function settle() {
    settled = true;
    stopTimer();
  }

  async function run(source) {
    if (settled || disposed) return { ok: false, skipped: true, reason: '已经结束' };
    if (running) return { ok: false, skipped: true, reason: '正在发' };
    running = true;
    let result;
    try {
      result = await trySend();
    } catch (error) {
      // trySend 自己抛错也不许冒出去：这条跟 internal/service 监听里那个 try/catch 同一条规矩
      const detail = `开机自报抛错：${String(error?.message ?? error)}`;
      warn(detail);
      result = { ok: false, reason: detail };
    }
    running = false;
    if (result?.ok || result?.skipped) {
      settle();
    } else if (source === 'fallback') {
      // 兜底发过一次就算走完：话已经由 ask 存进 pending，等主会话活跃再补，别在这里反复发。
      // 但「存着」不能只是存着：把 queued 结果交给 onQueued 开一段有上限的补发盯梢。
      if (result?.queued || result?.pending) {
        log('开机自报：兜底没发出去，这句已经在待发队列里，交给就绪补发盯梢');
        try {
          onQueued(result);
        } catch (error) {
          warn(`开机自报：启动补发盯梢失败：${String(error?.message ?? error)}`);
        }
      }
      settle();
    }
    return result;
  }

  /**
   * 就绪信号：agents 服务挂上、或安装时探到它已经在。
   * 只有 `canSend()` 真的成立才发——目标会话不在活表就继续等兜底。
   * @param {string} [source] 只进日志，方便排障看是哪条路触发的
   * @returns {boolean} 这次有没有真的去发
   */
  function noteReady(source = 'service') {
    if (settled || disposed) return false;
    let ready = false;
    try {
      ready = canSend() === true;
    } catch (error) {
      warn(`开机自报：判断能不能发时抛错：${String(error?.message ?? error)}`);
      ready = false;
    }
    if (!ready) return false;
    log(`开机自报：${source} 就绪且目标会话在活表，立刻发`);
    void run(source);
    return true;
  }

  /** 兜底：等够 waitMs 还没成功，就按老路发一次，并 warn 一条说明走了兜底。 */
  function startFallback() {
    if (settled || disposed || timer !== undefined) return;
    const tick = () => {
      timer = undefined;
      if (settled || disposed) return;
      // 事件已经触发、正在 await followup：让它自己收口，别叠第二条。
      // 但也不能就这么算了——它要是失败了没人再兜，所以把 timer 重挂上再看一眼。
      if (running) {
        timer = setTimer(tick, FALLBACK_RECHECK_MS);
        if (typeof timer?.unref === 'function') timer.unref();
        return;
      }
      fallbacks += 1;
      warn(
        `开机自报：等了 ${Math.max(0, Number(waitMs) || 0)} 毫秒还没等到 agents 服务 + 目标会话在活表，` +
          '走兜底按老路发一次（发不出去就存着，等主会话下一次活跃时补发）',
      );
      void run('fallback');
    };
    timer = setTimer(tick, Math.max(0, Number(waitMs) || 0));
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function dispose() {
    disposed = true;
    stopTimer();
  }

  return {
    noteReady,
    startFallback,
    dispose,
    get settled() {
      return settled;
    },
    get running() {
      return running;
    },
    get fallbacks() {
      return fallbacks;
    },
  };
}
