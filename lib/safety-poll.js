/**
 * 兜底轮询：`nextRunAt` 过期了却没人叫醒时，把这一拍补起来。
 *
 * 为什么需要它（真机实测）：整点主拍切到 dsh-timer 的 tick 之后，
 * `port.drive('tick')` 会停掉自己的 60 秒轮询、清掉 `armWake` 的一次性 timer，
 * 之后唯一会重排唤醒的地方只剩「收到下一拍整点 tick」。而 `dsh_hot_reload` 是
 * 「撤旧 fiber → 挂新 fiber」：撤的时候 `ctx.effect` 的收尾把 timer 清了，新实例
 * apply 时 `nextRunAt` 还在未来（13:00 热加载，13:02:21 那一拍），既不满足
 * 「第一次启动才 planNext」，也没有任何地方 armWake，于是 13:02 这一拍静默丢掉，
 * 一直空到 14:00 整点 tick 才算回来。
 *
 * 同类丢唤醒的路径不止热加载：进程被挂起、系统时钟往前跳、timer 被别的东西
 * clear 掉，症状都一样——`nextRunAt` 摆在那儿过期，没人管。
 *
 * 所以这条路刻意做成**不看驱动源、不看模式**的低频轮询：每 25 秒读一次内存里的
 * `state.nextRunAt` / `retryAfterAt` / `ticking`（不读盘、不碰服务句柄），过期且
 * 没在跑就调一次 `onDue`。真正跑不跑仍由 `tick()` 自己的闸和 `nextRunAt` 判，
 * 这里只负责「别忘了叫」。
 *
 * 三条不催的规矩：
 *   · 插件关着（`enabled = false`）：叫了也不跑，别空转；
 *   · 上一拍还在跑（`ticking`）：并发由 `tick()` 挡，但这里先让开，省一次重入；
 *   · 连败推后期没到（`retryAfterAt` 在未来）：排期本来就该等着，催了也是白催。
 */

/** 25 秒一拍：比 60 秒主拍密，丢唤醒后最多多等半分钟；比每分钟轻不了多少。 */
export const DEFAULT_SAFETY_INTERVAL_MS = 25_000;

/**
 * 造一个兜底轮询器。
 *
 * @param {{
 *   intervalMs?: number,
 *   isEnabled?: () => boolean,
 *   isBusy?: () => boolean,
 *   nextRunAt?: () => number|undefined,
 *   retryAfterAt?: () => number|undefined,
 *   now?: () => number,
 *   onDue?: (info: { at: number, nowMs: number }) => unknown,
 *   log?: (line: string) => void,
 *   setInterval?: (fn: () => void, ms: number) => any,
 *   clearInterval?: (handle: any) => void,
 * }} options
 */
export function createSafetyPoll(options = {}) {
  const {
    intervalMs = DEFAULT_SAFETY_INTERVAL_MS,
    isEnabled = () => true,
    isBusy = () => false,
    nextRunAt = () => undefined,
    retryAfterAt = () => undefined,
    now = () => Date.now(),
    onDue = () => {},
    log = () => {},
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
  } = options;

  let handle;
  let stopped = false;
  /** 上一次催过的那个 nextRunAt：同一拍只播报一行，别每 25 秒刷一次日志。 */
  let lastNudgedAt = 0;

  /**
   * 看一眼该不该催。抽成同步函数是为了单测能直接调，不必碰 timer。
   *
   * @returns {boolean} 这一眼看有没有催
   */
  function check() {
    if (stopped) return false;
    if (!isEnabled()) return false;
    if (isBusy()) return false;
    const at = Number(nextRunAt());
    if (!Number.isFinite(at) || at <= 0) return false;
    const nowMs = now();
    if (at > nowMs) return false;
    const retry = Number(retryAfterAt());
    if (Number.isFinite(retry) && retry > nowMs) return false;
    if (at !== lastNudgedAt) {
      lastNudgedAt = at;
      log(
        `兜底轮询：下一拍 ${new Date(at).toLocaleString('zh-CN', { hour12: false })} 早过期了还没人叫醒` +
          `（热加载/时钟跳变/timer 丢了），现在补跑`,
      );
    }
    try {
      onDue({ at, nowMs });
    } catch (error) {
      log(`兜底轮询：补跑回调抛错：${String(error?.message ?? error)}`);
    }
    return true;
  }

  function start() {
    if (handle !== undefined || stopped) return;
    handle = setIntervalFn(check, intervalMs);
    if (typeof handle?.unref === 'function') handle.unref();
  }

  function stop() {
    stopped = true;
    if (handle !== undefined) clearIntervalFn(handle);
    handle = undefined;
  }

  return {
    start,
    stop,
    check,
    get stopped() {
      return stopped;
    },
  };
}
