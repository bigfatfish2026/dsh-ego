/**
 * 开机自报兜底没发出去之后的「就绪补发」盯梢。
 *
 * 背景（2026-11-10 00:20 那次重启）：10 秒兜底到点时会话还差 1 秒才进活表，
 * ask() 把自报那句排进 pendingSayQueue 就算收口；下一次有机会重试是整点那一拍，
 * 而那一拍先按 pendingTtlMinutes 清过期——30 分钟 TTL 撑不到 60 分钟后的整点，话就丢了。
 *
 * 这里只做一件事：兜底失败、话已经真在队列里之后，在窗口内每秒看一眼目标会话活没活；
 * 活了就走 retryPending 补发。补发看的是队列本身（发成功 ask 会 ack 掉那条），
 * 所以不重发 announce、不碰 announcer.sent，绝不会跟「已发」状态打架，也不会发第二条。
 */

/** 补发窗口默认 30 秒：兜底本身在 10 秒，合起来最晚开机后约 40 秒收口，不会拖到一分钟。 */
export const DEFAULT_ANNOUNCE_RETRY_WINDOW_MS = 30_000;

/** 窗口内多久看一眼会话活没活：1 秒一次，覆盖 warmup 那种「差一秒」的竞态。 */
export const ANNOUNCE_RETRY_INTERVAL_MS = 1_000;

/** 窗口上限（毫秒）：非有限值或负数退回默认 30 秒，0 表示不盯（直接交给每拍重试）。 */
export function announceRetryWindowMs(baseMs = DEFAULT_ANNOUNCE_RETRY_WINDOW_MS) {
  const base = Number(baseMs);
  if (!Number.isFinite(base) || base < 0) return DEFAULT_ANNOUNCE_RETRY_WINDOW_MS;
  return base;
}

/**
 * @param {{
 *   windowMs?: number,
 *   intervalMs?: number,
 *   canSend?: () => boolean,
 *   hasPending: () => boolean,
 *   retryPending: (nowMs: number) => Promise<unknown>,
 *   log?: (line: string) => void,
 *   warn?: (line: string) => void,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (timer: any) => void,
 *   now?: () => number,
 * }} options
 */
export function createAnnounceRetry(options = {}) {
  const {
    windowMs = DEFAULT_ANNOUNCE_RETRY_WINDOW_MS,
    intervalMs = ANNOUNCE_RETRY_INTERVAL_MS,
    canSend = () => true,
    hasPending,
    retryPending,
    log = () => {},
    warn = () => {},
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
    now = () => Date.now(),
  } = options;

  if (typeof hasPending !== 'function') {
    throw new TypeError('createAnnounceRetry 需要 hasPending 函数');
  }
  if (typeof retryPending !== 'function') {
    throw new TypeError('createAnnounceRetry 需要 retryPending 函数');
  }

  const window = announceRetryWindowMs(windowMs);
  const gap = Number(intervalMs) > 0 ? Number(intervalMs) : ANNOUNCE_RETRY_INTERVAL_MS;

  /** 还在盯：start() 之后、补发成功或窗口到期之前。 */
  let active = false;
  /** 正在调 retryPending：那一下会 await followup，别让别处再插一嘴。 */
  let running = false;
  let timer;
  let deadline = 0;
  let attempts = 0;

  function stopTimer() {
    if (timer === undefined) return;
    try {
      clearTimer(timer);
    } catch {
      /* 清不掉也不影响收口 */
    }
    timer = undefined;
  }

  function finish(reason) {
    active = false;
    stopTimer();
    log(`开机自报补发盯梢结束：${reason}`);
  }

  async function tick() {
    timer = undefined;
    if (!active) return;
    // 队列里已经没有这句了：要么别的路已经补发（ask 成功会 ack），要么被 TTL 清掉
    if (!hasPending()) {
      finish('这句已经不在待发队列里');
      return;
    }
    if (now() >= deadline) {
      warn(
        `开机自报：兜底那句在 ${Math.round(window / 1000)} 秒补发窗口里没等到目标会话进活表，` +
          '交给每分钟那一拍/整点那一拍的 pending 重试',
      );
      finish('补发窗口到了');
      return;
    }
    let ready = false;
    try {
      ready = canSend() === true;
    } catch (error) {
      warn(`开机自报补发：判断会话活没活时抛错：${String(error?.message ?? error)}`);
      ready = false;
    }
    if (ready) {
      attempts += 1;
      running = true;
      try {
        await retryPending(now());
      } catch (error) {
        warn(`开机自报补发：重试待发队列抛错：${String(error?.message ?? error)}`);
      }
      running = false;
      if (!active) return; // dispose 的时候刚好在发
      if (!hasPending()) {
        finish(`补发出去了（第 ${attempts} 次重试成功）`);
        return;
      }
    }
    timer = setTimer(tick, gap);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  /**
   * 开始盯。队列里没有这句、或窗口配成 0，就直接不盯（交给每拍重试）。
   * @returns {boolean} 有没有真的开始盯
   */
  function start() {
    if (active) return false;
    if (window <= 0) {
      log('开机自报补发窗口 = 0，不盯，交给每分钟那一拍/整点那一拍的 pending 重试');
      return false;
    }
    if (!hasPending()) {
      log('开机自报：这句已经不在待发队列里，不用盯补发');
      return false;
    }
    active = true;
    attempts = 0;
    deadline = now() + window;
    log(
      `开机自报：兜底那句已经排进待发队列，接下来 ${Math.round(window / 1000)} 秒每秒看一眼会话活没活，` +
        '活了就补发一次',
    );
    void tick();
    return true;
  }

  function dispose() {
    active = false;
    running = false;
    stopTimer();
  }

  return {
    start,
    dispose,
    get active() {
      return active;
    },
    get attempts() {
      return attempts;
    },
  };
}
