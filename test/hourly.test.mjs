/**
 * 整点 tick 的纯函数单测：周期去重、过期一拍跳到当前整点、没带 periodKey 的兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PERIOD_MS, acceptTick, hourStartMs, tickPeriodKey, wakeAtForTick } from '../lib/hourly.js';

const HOUR = Date.parse('2026-11-09T20:00:00+08:00');
const MIN = 60 * 1000;

test('hourStartMs：取本地整点，不跨时区偏移', () => {
  const date = new Date(HOUR + 37 * MIN + 1234);
  assert.equal(hourStartMs(date.getTime()), HOUR);
  assert.equal(PERIOD_MS, 60 * 60 * 1000);
});

test('周期去重：同一 periodKey 只收一次，过期/乱序的不收', () => {
  const key = 'ego.hourly.hourly.2026-11-09T20';
  assert.equal(acceptTick('', key), true, '第一拍要收');
  assert.equal(acceptTick(key, key), false, '同周期重复投递不收');
  assert.equal(acceptTick(key, 'ego.hourly.hourly.2026-11-09T19'), false, '更老的周期不收');
  assert.equal(acceptTick(key, 'ego.hourly.hourly.2026-11-09T21'), true, '新周期要收');
  assert.equal(acceptTick(key, ''), true, '没带 key 的收下，靠 nextRunAt 那道闸兜底');
});

test('wakeAtForTick：整点 + 0~delayMaxMinutes 随机，行为与旧主拍等价', () => {
  const firedAt = HOUR + 200; // dsh-timer 扫描最多晚 2 秒
  const plan = wakeAtForTick({ firedAt, nowMs: firedAt, delayMaxMinutes: 8, random: () => 0.5 });
  assert.equal(plan.stale, false);
  assert.equal(plan.at, firedAt + 4 * MIN, '随机落在一半');
  assert.ok(plan.at >= firedAt && plan.at <= firedAt + 8 * MIN);
});

test('wakeAtForTick：delayMaxMinutes 为 0 就正好整点，随机不越界', () => {
  const plan = wakeAtForTick({ firedAt: HOUR, nowMs: HOUR + 1000, delayMaxMinutes: 0, random: () => 0.999 });
  assert.equal(plan.at, HOUR);
});

test('wakeAtForTick：过期一拍跳到当前整点重排，不补一串', () => {
  const now = HOUR + 20 * MIN; // 宿主睡了 20 分钟才醒
  const plan = wakeAtForTick({
    firedAt: HOUR - 40 * MIN, // 上一拍（更早的整点）
    nowMs: now,
    delayMaxMinutes: 8,
    random: () => 0,
  });
  assert.equal(plan.stale, true);
  assert.equal(plan.at, HOUR, '按当前整点重排，不从过期那一拍往后补');
});

test('tickPeriodKey：带 key 原样用；没带就按 firedAt 的整点造一个', () => {
  assert.equal(
    tickPeriodKey({ name: 'ego.hourly.tick', firedAt: new Date(HOUR).toISOString(), periodKey: 'ego.hourly.hourly.2026-11-09T20' }),
    'ego.hourly.hourly.2026-11-09T20',
  );
  assert.equal(
    tickPeriodKey({ name: 'ego.hourly.tick', firedAt: new Date(HOUR + 5 * MIN).toISOString() }),
    `ego.hourly.fallback.${HOUR}`,
  );
  assert.equal(tickPeriodKey({}), '', '既没 key 也没 firedAt：空串，调用方当「没周期」放行');
});
