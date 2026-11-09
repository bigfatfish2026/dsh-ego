/**
 * 时段判定与整点排期（纯函数，可在 node 里单独测，不依赖 dsh）
 *
 * 谷价 / 峰价按 DeepSeek 官方定价（北京时间）：
 *   峰时：周一~周五 09:00-12:00、14:00-18:00
 *   谷时：其余全部——12:00-14:00 午休、18:00-次日 09:00、周六周日全天、法定节假日全天
 *
 * 安静时段（默认 23:40 到次日 8 点）盖住一切：这段时间根本不掷骰子。
 * 安静时段支持小数小时：23.66 = 23:40，安静判断精确到分钟。
 */

const MINUTE = 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD */
export function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 是否峰价时段（贵的那个） */
export function isPeak(date, holidays = []) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false; // 周末全天谷价
  if (holidays.includes(ymd(date))) return false; // 法定节假日
  const h = date.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 一天里的第几分钟（含秒的小数部分），安静时段按分钟比 */
function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

/**
 * 安静时段：含起不含止，支持跨午夜（23.66 → 8）。
 * 起止都用「小时」写，允许小数：23.66 = 23 点 39.6 分。
 */
export function inQuiet(date, quietStart, quietEnd) {
  const startHour = Number(quietStart);
  const endHour = Number(quietEnd);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return false;
  if (startHour === endHour) return false; // 起止相同 = 不启用
  const start = startHour * 60;
  const end = endHour * 60;
  const now = minuteOfDay(date);
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

/**
 * 现在能不能开口（不含冷却/间隔，那些看 state 和配置）。
 * @returns {{ok: boolean, reason: string}}
 */
export function speakingWindow(date, cfg) {
  if (inQuiet(date, cfg.quietStart, cfg.quietEnd)) {
    return { ok: false, reason: `安静时段（${cfg.quietStart} 点-${cfg.quietEnd} 点）` };
  }
  if (cfg.offPeakOnly && isPeak(date, cfg.holidays ?? [])) {
    return { ok: false, reason: '现在是峰价时段，不开口' };
  }
  return { ok: true, reason: '谷价时段' };
}

/** 往后找下一个能开口的时刻（找不到就是 null） */
export function nextWindow(date, cfg, maxDays = 8) {
  const step = 10 * 60 * 1000;
  let t = new Date(date.getTime());
  t.setSeconds(0, 0);
  for (let i = 0; i < (maxDays * 24 * 60 * 60 * 1000) / step; i += 1) {
    if (speakingWindow(t, cfg).ok) return t;
    t = new Date(t.getTime() + step);
  }
  return null;
}

/** 掷骰子：掷到命中线以下才算「有念头」 */
export function rollDice(random = Math.random) {
  return Math.round(random() * 1000) / 10;
}

export function hit(roll, hitLine) {
  return roll < Number(hitLine);
}

/**
 * 下一个整点（严格大于 now：now 正好 14:00:00 时给 15:00:00）。
 * 定时器本来就是每分钟看一眼，落在整点后一小会儿才真跑。
 */
export function nextHourTick(now = new Date()) {
  const t = new Date(now.getTime());
  t.setMinutes(0, 0, 0);
  t.setHours(t.getHours() + 1);
  return t;
}

/**
 * 这一拍距现在还有多少毫秒 = 到下一个整点 + 0~delayMaxMinutes 分钟随机。
 * @param {Date} now 现在
 * @param {{delayMaxMinutes?: number}} cfg 配置
 * @param {() => number} random 随机源（测试注入）
 */
export function delayMs(now = new Date(), cfg = {}, random = Math.random) {
  const max = Number(cfg.delayMaxMinutes);
  const cap = Number.isFinite(max) && max > 0 ? max : 0;
  const toHour = Math.max(0, nextHourTick(now).getTime() - now.getTime());
  return toHour + Math.round(random() * cap * MINUTE);
}
