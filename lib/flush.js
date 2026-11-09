/**
 * 存着的话/票的即时补发调度器。
 *
 * 背景：宿主重启后 sessions 表是空的，主会话的 agent 要等第一条入站消息才会由
 * getOrCreate → openSession 去 resume。在那之前 ctx.agents.get() 查不到，
 * followup 也没有出站路由能认的 record，所以开机自报只能先存着。
 *
 * tick 每分钟才兜一次；这里在主会话刚说话时盯一段时间，等它那一轮跑完变 idle 就立刻补。
 * 时间源、重试函数全部注入，单测不真等 2 分钟。
 */
export const PENDING_FLUSH_INTERVAL_MS = 3000;
/** 40 次 × 3 秒 ≈ 2 分钟：用户一条消息触发的一轮一般跑得完 */
export const PENDING_FLUSH_TRIES = 40;

/**
 * @param {{
 *   retryPending: (nowMs: number) => Promise<unknown>,
 *   hasPending: () => boolean,
 *   log?: (line: string) => void,
 *   intervalMs?: number,
 *   tries?: number,
 *   setTimeout?: typeof setTimeout,
 *   clearTimeout?: typeof clearTimeout,
 * }} options
 */
export function createPendingFlusher(options = {}) {
  const {
    retryPending,
    hasPending,
    log = () => {},
    intervalMs = PENDING_FLUSH_INTERVAL_MS,
    tries = PENDING_FLUSH_TRIES,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
  } = options;

  let flushing = false;
  let timer;

  function schedule(reason = '主会话有动静') {
    if (flushing) {
      log(`${reason}：已经在盯存着的话/票了，不重复开一条`);
      return false;
    }
    if (!hasPending()) return false;
    flushing = true;
    let count = 0;

    const attempt = () => {
      count += 1;
      Promise.resolve()
        .then(() => retryPending(Date.now()))
        .catch((error) => log(`补发调度抛错：${String(error?.message ?? error)}`))
        .then(() => {
          if (!hasPending()) {
            flushing = false;
            return;
          }
          if (count >= tries) {
            flushing = false;
            log(`盯了 ${count} 次还没补发出去（主会话可能一直忙），交给每分钟那一拍`);
            return;
          }
          timer = setTimer(attempt, intervalMs);
          if (typeof timer?.unref === 'function') timer.unref();
        });
    };

    log(`${reason}：盯一眼存着的话/票能不能补发（每 ${intervalMs / 1000} 秒一次，最多 ${tries} 次）`);
    attempt();
    return true;
  }

  function stop() {
    flushing = false;
    clearTimer(timer);
    timer = undefined;
  }

  return {
    schedule,
    stop,
    get flushing() {
      return flushing;
    },
  };
}
