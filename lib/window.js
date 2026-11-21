/**
 * 时段判定与整点排期（纯函数，可在 node 里单独测，不依赖 dsh）
 *
 * 谷价 / 峰价按 DeepSeek 官方定价（北京时间）：
 *   峰时：周一~周五 09:00-12:00、14:00-18:00
 *   谷时：其余全部——12:00-14:00 午休、18:00-次日 09:00、周六周日全天、法定节假日全天
 *
 * 谷价规则优先用外部 dsh-price-clock（节假日表在那边维护），路径可用
 * `DSH_EGO_PRICE_CLOCK` 指定；没装外部模块就退回本文件里的内置规则。
 * 以前这里自己算一遍、节假日靠配置里手填的 holidays 数组，默认空数组时等于没判。
 *
 * 安静时段（默认 23:40 到次日 8 点）盖住一切：这段时间根本不掷骰子。
 * 安静时段支持小数小时：23.66 = 23:40，安静判断精确到分钟。
 */
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeTickIntervalMinutes, periodMsFor, periodStartMs } from './hourly.js';

const MINUTE = 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

/** 外部时钟读不到时的兜底：周一~周五 09:00-12:00、14:00-18:00 为峰，其余都便宜（不含节假日表）。 */
function builtinIsCheapNow(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return true;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return !((minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60));
}

const PRICE_CLOCK_PATH = process.env.DSH_EGO_PRICE_CLOCK
  || path.join(os.homedir(), 'fatfish', 'plugins', 'dsh-price-clock', 'lib', 'clock.js');

let isCheapNow = builtinIsCheapNow;
try {
  const clock = await import(pathToFileURL(PRICE_CLOCK_PATH).href);
  if (typeof clock.isCheapNow === 'function') isCheapNow = clock.isCheapNow;
} catch {
  /* 没装外部时钟模块：继续用内置规则 */
}

/** 本地日期 YYYY-MM-DD */
export function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 是否峰价时段（贵的那个）。
 * 判据交给 dsh-price-clock；holidays 是历史配置项，填了就额外当节假日（不改主规则）。
 */
export function isPeak(date, holidays = []) {
  if (holidays.includes(ymd(date))) return false;
  return !isCheapNow(date);
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
  if (startHour < 0 || startHour > 24 || endHour < 0 || endHour > 24) return false; // 越界 = 不启用
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
  return nextPeriodTick(now, 60);
}

/**
 * 下一个周期起点（严格大于 now）。tickIntervalMinutes=60 时与 nextHourTick 等价，
 * 默认配置下排期行为一字不变；配成 10 就是每 10 分钟的边界。
 */
export function nextPeriodTick(now = new Date(), tickIntervalMinutes = 60) {
  const minutes = normalizeTickIntervalMinutes(tickIntervalMinutes);
  return new Date(periodStartMs(now.getTime(), minutes) + periodMsFor(minutes));
}

/**
 * 这一拍距现在还有多少毫秒 = 到下一个周期起点 + 0~delayMaxMinutes 分钟随机。
 * 周期是 tickIntervalMinutes（默认 60）；随机上限同时夹到「周期 - 1 分钟」，
 * 免得 1 分钟档把下一拍排到下一个周期里。默认 60 时 min(8, 59)=8，与改造前一致。
 *
 * @param {Date} now 现在
 * @param {{delayMaxMinutes?: number, tickIntervalMinutes?: number}} cfg 配置
 * @param {() => number} random 随机源（测试注入）
 */
export function delayMs(now = new Date(), cfg = {}, random = Math.random) {
  const minutes = normalizeTickIntervalMinutes(cfg.tickIntervalMinutes);
  const max = Number(cfg.delayMaxMinutes);
  const capRaw = Number.isFinite(max) && max > 0 ? max : 0;
  const cap = Math.min(capRaw, minutes - 1);
  const toTick = Math.max(0, nextPeriodTick(now, minutes).getTime() - now.getTime());
  return toTick + Math.round(random() * cap * MINUTE);
}
