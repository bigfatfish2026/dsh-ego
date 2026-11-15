/**
 * 调度间隔可配。
 *
 * tickIntervalMinutes 是「多久判一次」的真间隔：cron、周期毫秒、周期起点、nextRunAt
 * 全部跟着它走；默认 60 必须与改造前逐字一致（'0 * * * *'、整点 + 0~8 分钟随机）。
 * 非法值回落 60，由 apply 打日志。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cronForInterval,
  normalizeTickIntervalMinutes,
  periodMsFor,
  periodStartMs,
  wakeAtForTick,
} from '../lib/hourly.js';
import { delayMs, nextHourTick, nextPeriodTick } from '../lib/window.js';
import { HOURLY_RULE_ID, createHourlyDriver } from '../lib/hourly-driver.js';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-14T20:00:00+08:00');
const at = (iso) => Date.parse(iso);

test('周期分钟数：只收 1–60 且整除 60，其余回落 60', () => {
  assert.equal(normalizeTickIntervalMinutes(60), 60);
  assert.equal(normalizeTickIntervalMinutes(10), 10);
  assert.equal(normalizeTickIntervalMinutes(1), 1);
  assert.equal(normalizeTickIntervalMinutes(45), 60, '45 不整除 60，回落默认');
  assert.equal(normalizeTickIntervalMinutes(7), 60);
  assert.equal(normalizeTickIntervalMinutes(0), 60);
  assert.equal(normalizeTickIntervalMinutes(61), 60);
  assert.equal(normalizeTickIntervalMinutes(1.5), 60);
  assert.equal(normalizeTickIntervalMinutes('abc'), 60);
  assert.equal(normalizeTickIntervalMinutes(undefined), 60);
});

test('cron 与周期毫秒：60 = 老规则，10 = */10', () => {
  assert.equal(cronForInterval(60), '0 * * * *');
  assert.equal(cronForInterval(10), '*/10 * * * *');
  assert.equal(periodMsFor(60), 60 * MIN);
  assert.equal(periodMsFor(10), 10 * MIN);
  assert.equal(periodMsFor(45), 60 * MIN, '非法值按 60 分钟算');
});

test('周期起点：60 档是整点，10 档每 10 分钟一个边界', () => {
  assert.equal(periodStartMs(at('2026-11-14T20:59:59+08:00'), 60), T0);
  assert.equal(periodStartMs(at('2026-11-14T20:07:30+08:00'), 10), T0);
  assert.equal(periodStartMs(at('2026-11-14T20:19:59+08:00'), 10), at('2026-11-14T20:10:00+08:00'));
  assert.equal(periodStartMs(at('2026-11-14T20:10:00+08:00'), 10), at('2026-11-14T20:10:00+08:00'));
});

test('wakeAtForTick：10 分钟档按周期起点 + 0~delayMax 随机，过期不补', () => {
  const fired = at('2026-11-14T20:10:00+08:00');
  const plan = wakeAtForTick({
    firedAt: fired,
    nowMs: fired + 2000,
    delayMaxMinutes: 8,
    periodMinutes: 10,
    random: () => 0.5,
  });
  assert.equal(plan.stale, false);
  assert.equal(plan.at, fired + 4 * MIN);

  const stale = wakeAtForTick({
    firedAt: at('2026-11-14T19:50:00+08:00'),
    nowMs: at('2026-11-14T20:12:00+08:00'),
    delayMaxMinutes: 8,
    periodMinutes: 10,
    random: () => 0,
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.at, at('2026-11-14T20:10:00+08:00'), '按当前周期起点重排');
});

test('nextRunAt 排期：60 档与 nextHourTick 完全等价，10 档落在 10 分钟边界', () => {
  const now = new Date(at('2026-11-14T20:07:00+08:00'));
  assert.equal(nextPeriodTick(now, 60).getTime(), nextHourTick(now).getTime());
  assert.equal(nextPeriodTick(now, 60).getTime(), at('2026-11-14T21:00:00+08:00'));
  assert.equal(nextPeriodTick(now, 10).getTime(), at('2026-11-14T20:10:00+08:00'));

  const old = delayMs(now, { delayMaxMinutes: 8 }, () => 0.5);
  const hourly = delayMs(now, { delayMaxMinutes: 8, tickIntervalMinutes: 60 }, () => 0.5);
  assert.equal(hourly, old, '默认 60 与改造前的 delayMs 逐毫秒一致');
  assert.equal(hourly, 53 * MIN + 4 * MIN);

  const tenMinute = delayMs(now, { delayMaxMinutes: 8, tickIntervalMinutes: 10 }, () => 0.5);
  assert.equal(tenMinute, 3 * MIN + 4 * MIN, '到 20:10 还剩 3 分钟，再加 0~8 的一半');

  const oneMinute = delayMs(now, { delayMaxMinutes: 8, tickIntervalMinutes: 1 }, () => 1);
  assert.equal(oneMinute, MIN, '1 分钟档随机上限夹成 0，不许跨进下一个周期');
});

/** 只够 driver 用的假 clock：记下 watchdog 的间隔。 */
function fakeClock(start = T0) {
  let now = start;
  const intervals = [];
  return {
    now: () => new Date(now),
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval(id) {
      const one = intervals[id - 1];
      if (one) one.ms = -1;
    },
    intervals,
  };
}

function fakeEvents() {
  const defs = new Map();
  return {
    defineEvent(def) {
      defs.set(def.name, def);
      return def;
    },
    registry: { get: (name) => defs.get(name), has: (name) => defs.has(name) },
    subscribe() {
      return { stop() {} };
    },
  };
}

function fakeSchedule() {
  const rules = new Map();
  return {
    calls: [],
    rules,
    register(def) {
      this.calls.push(def);
      rules.set(def.id, def);
      return { id: def.id, topic: def.topic };
    },
    unregister(id) {
      return rules.delete(id);
    },
  };
}

function startDriver({ cron, periodMs } = {}) {
  const clock = fakeClock();
  const schedule = fakeSchedule();
  const driver = createHourlyDriver({
    port: { pulse() {}, drive() {} },
    events: () => fakeEvents(),
    schedule: () => schedule,
    clock,
    ...(cron === undefined ? {} : { cron }),
    ...(periodMs === undefined ? {} : { periodMs }),
  });
  driver.reconcile();
  return { driver, schedule, clock };
}

test('驱动源：默认注册的 cron 与 watchdog 断流线保持改造前的小时级', () => {
  const { driver, schedule, clock } = startDriver();
  assert.equal(driver.mode(), 'tick');
  assert.equal(schedule.rules.get(HOURLY_RULE_ID).cron, '0 * * * *');
  assert.ok(
    clock.intervals.some((one) => one.ms === 60 * MIN),
    'watchdog 按一小时周期睁眼（断流线 = 3 × periodMs）',
  );
});

test('驱动源：10 分钟档注册 */10，watchdog 按 10 分钟周期', () => {
  const { schedule, clock } = startDriver({ cron: cronForInterval(10), periodMs: periodMsFor(10) });
  assert.equal(schedule.rules.get(HOURLY_RULE_ID).cron, '*/10 * * * *');
  assert.deepEqual(schedule.calls[0], {
    id: HOURLY_RULE_ID,
    cron: '*/10 * * * *',
    topic: 'ego.hourly.tick',
    catchUp: 'skip',
  });
  assert.ok(clock.intervals.some((one) => one.ms === 10 * MIN), 'watchdog 睁眼/断流线跟着周期收窄');
});
