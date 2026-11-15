/**
 * 一拍周期的几个纯函数（可在 node 里单独测，不依赖 dsh）
 *
 * 旧主拍是「每分钟看一眼，nextRunAt 到了才真跑」；换成事件驱动后，周期起点那一拍由
 * dsh-timer 发来，ego 收到再按「周期起点 + 0~delayMaxMinutes 随机」算这一拍几点醒。
 * 算时间、认周期、去重都在这里，index.js / lifecycle.js 只负责接线。
 *
 * 周期默认 60 分钟（每个整点），配置项是 ego.tickIntervalMinutes。这个间隔是**真间隔**：
 * 调小它就是判定得更勤，每次判定仍按 diceProbability 掷骰，所以实际干活频率会跟着上升
 * （票台闸只在「正好有活」时挡掉那一拍）。默认 60 分钟与改造前逐字等价。
 */

/** 默认周期：一小时。留这个常量给老调用方和测试。 */
export const PERIOD_MS = 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

/**
 * 周期分钟数的合法化：只收 1–60 且能整除 60 的整数（这样 cron 里每 N 分钟的边界
 * 与周期起点完全对齐，不会出现「最后一段只有 4 分钟」的节奏）。
 * 非法值一律回落 60，由调用方决定要不要打一行 warn——这里只做纯函数判定。
 */
export function normalizeTickIntervalMinutes(value, fallback = 60) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < 1 || n > 60 || 60 % n !== 0) return fallback;
  return n;
}

/** 一个周期多少毫秒。默认 60 分钟 = PERIOD_MS。 */
export function periodMsFor(minutes = 60) {
  return normalizeTickIntervalMinutes(minutes) * MINUTE_MS;
}

/** 某个时刻所在周期的起点（本地时钟对齐；60 分钟时就是整点）。 */
export function periodStartMs(ms, minutes = 60) {
  const size = normalizeTickIntervalMinutes(minutes);
  const date = new Date(ms);
  const start = new Date(ms);
  start.setSeconds(0, 0);
  start.setMinutes(Math.floor(date.getMinutes() / size) * size);
  return start.getTime();
}

/**
 * 周期对应的 cron：60 分钟仍是「每小时 0 分」，逐字沿用旧规则；
 * 其他周期写成每 N 分钟一条（N 整除 60，边界与 periodStartMs 一致）。
 */
export function cronForInterval(minutes = 60) {
  const size = normalizeTickIntervalMinutes(minutes);
  return size === 60 ? '0 * * * *' : `*/${size} * * * *`;
}

/** 某个时刻所在整点的时间戳（本地时区；北京没有夏令时，整点就是整点） */
export function hourStartMs(ms) {
  return periodStartMs(ms, 60);
}

/**
 * 这一拍 tick 的周期标识。dsh-timer 会带 periodKey；万一没带，就拿 firedAt 的
 * 周期起点现造一个，保证同一拍重复投递还认得出是同一拍。
 */
export function tickPeriodKey(payload, minutes = 60) {
  const key = typeof payload?.periodKey === 'string' ? payload.periodKey.trim() : '';
  if (key) return key;
  const firedAt = Date.parse(typeof payload?.firedAt === 'string' ? payload.firedAt : '');
  return Number.isFinite(firedAt) ? `ego.hourly.fallback.${periodStartMs(firedAt, minutes)}` : '';
}

/**
 * 同一周期只认一次：重复投递、乱序投递（key 比上次小）都丢掉。
 * 不传 key 的（老 timer 没带）一律收下——去重靠 nextRunAt 那条闸兜底。
 */
export function acceptTick(lastKey, key) {
  if (!key) return true;
  if (!lastKey) return true;
  return String(key) > String(lastKey);
}

/**
 * 收到周期 tick 后该在什么时候醒：周期起点 + 0~delayMaxMinutes 分钟随机。
 *
 * 过期一拍（firedAt 已经不在当前周期里，例如宿主睡了 20 分钟、或补发迟到）
 * 不补：直接按当前周期起点重排，绝不补一串。
 *
 * @returns {{ at: number, stale: boolean }}
 */
export function wakeAtForTick({
  firedAt,
  nowMs = Date.now(),
  delayMaxMinutes = 0,
  periodMinutes = 60,
  random = Math.random,
} = {}) {
  const fired = Number.isFinite(Number(firedAt)) ? Number(firedAt) : nowMs;
  const current = periodStartMs(nowMs, periodMinutes);
  const stale = fired < current;
  const base = stale ? current : fired;
  const max = Number(delayMaxMinutes);
  const cap = Number.isFinite(max) && max > 0 ? max : 0;
  const at = base + Math.round(random() * cap * MINUTE_MS);
  return { at, stale };
}
