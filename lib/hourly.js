/**
 * 整点 tick 的几个纯函数（可在 node 里单独测，不依赖 dsh）
 *
 * 旧主拍是「每分钟看一眼，nextRunAt 到了才真跑」；换成事件驱动后，整点那一拍由
 * dsh-timer 发来，ego 收到再按「整点 + 0~delayMaxMinutes 随机」算这一小时几点醒。
 * 算时间、认周期、去重都在这里，index.js 只负责接线。
 */

export const PERIOD_MS = 60 * 60 * 1000;

/** 某个时刻所在整点的时间戳（本地时区；北京没有夏令时，整点就是整点） */
export function hourStartMs(ms) {
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/**
 * 这一拍 tick 的周期标识。dsh-timer 会带 periodKey；万一没带，就拿 firedAt 的整点
 * 现造一个，保证同一拍重复投递还认得出是同一拍。
 */
export function tickPeriodKey(payload) {
  const key = typeof payload?.periodKey === 'string' ? payload.periodKey.trim() : '';
  if (key) return key;
  const firedAt = Date.parse(typeof payload?.firedAt === 'string' ? payload.firedAt : '');
  return Number.isFinite(firedAt) ? `ego.hourly.fallback.${hourStartMs(firedAt)}` : '';
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
 * 收到整点 tick 后该在什么时候醒：整点 + 0~delayMaxMinutes 分钟随机。
 *
 * 过期一拍（firedAt 已经不在当前整点里，例如宿主睡了 20 分钟、或补发迟到）
 * 不补：直接按当前整点重排，绝不补一串。
 *
 * @returns {{ at: number, stale: boolean }}
 */
export function wakeAtForTick({ firedAt, nowMs = Date.now(), delayMaxMinutes = 0, random = Math.random } = {}) {
  const fired = Number.isFinite(Number(firedAt)) ? Number(firedAt) : nowMs;
  const currentHour = hourStartMs(nowMs);
  const stale = fired < currentHour;
  const base = stale ? currentHour : fired;
  const max = Number(delayMaxMinutes);
  const cap = Number.isFinite(max) && max > 0 ? max : 0;
  const at = base + Math.round(random() * cap * 60 * 1000);
  return { at, stale };
}
