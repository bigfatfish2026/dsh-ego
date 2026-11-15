/**
 * 兜底轮询的回归测试 —— 对应 2026-11-11 真机那次丢拍：
 *
 * 13:00 热加载之后，原定 13:02:21 那一拍没跑，日志里 13:02–13:10 一条 stage1/stage2
 * 都没有，直到 14:00 整点 tick 才恢复。根因是「撤旧 fiber → 挂新 fiber」时旧实例的
 * armWake timer 被 dispose 清掉，新实例 apply 时 nextRunAt 还在未来，没人重排。
 *
 * 这里把「已经过期、但没人叫」的状态原样摆出来，断言兜底轮询能把它拉起来；
 * 再断言正在跑拍时不会重复触发（那条由 tick() 的 ticking 闸兜，但轮询也不该白叫）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SAFETY_INTERVAL_MS, createSafetyPoll } from '../lib/safety-poll.js';

const T0 = Date.parse('2026-11-11T13:05:00+08:00');

/** 假时钟：只让轮询器用，tick 的重排由测试自己写。 */
function fakeClock(start = T0) {
  let now = start;
  const intervals = [];
  return {
    now: () => now,
    setInterval(fn, ms) {
      const handle = { fn, ms, unref() {} };
      intervals.push(handle);
      return handle;
    },
    clearInterval(handle) {
      const index = intervals.indexOf(handle);
      if (index >= 0) intervals.splice(index, 1);
    },
    intervals,
    fire() {
      for (const one of [...intervals]) one.fn();
    },
  };
}

test('nextRunAt 已过期没人 arm：兜底轮询把这一拍拉起来', () => {
  const clock = fakeClock();
  let ticking = false;
  const state = { nextRunAt: Date.parse('2026-11-11T13:02:21+08:00') };
  const logs = [];
  const ticks = [];

  // 模拟真 tick：跑起来就置闸，跑完按下一拍重排（等价于 tick() 里的 planNext）
  const tick = () => {
    if (ticking) return;
    ticking = true;
    ticks.push(clock.now());
    state.nextRunAt = Date.parse('2026-11-11T14:03:10+08:00');
    ticking = false;
  };

  const poll = createSafetyPoll({
    isEnabled: () => true,
    isBusy: () => ticking,
    nextRunAt: () => state.nextRunAt,
    retryAfterAt: () => 0,
    now: clock.now,
    onDue: tick,
    log: (line) => logs.push(line),
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  poll.start();
  clock.fire();

  assert.equal(ticks.length, 1, '过期的那一拍要被补起来');
  assert.equal(state.nextRunAt, Date.parse('2026-11-11T14:03:10+08:00'), '补跑后按下一拍重排');
  assert.equal(logs.length, 1, '同一拍只播报一行');
  assert.match(logs[0], /兜底轮询：下一拍 .* 早过期/, '日志要说清是兜底补的');

  // 排期已经推到未来：再睁眼也不该催
  clock.fire();
  assert.equal(ticks.length, 1, '重排之后不再重复催');
});

test('已过期但正在跑拍：兜底轮询不重复触发', () => {
  const clock = fakeClock();
  let ticking = true;
  let due = 0;
  const poll = createSafetyPoll({
    isBusy: () => ticking,
    nextRunAt: () => Date.parse('2026-11-11T13:02:21+08:00'),
    now: clock.now,
    onDue: () => {
      due += 1;
    },
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  poll.start();

  clock.fire();
  clock.fire();
  assert.equal(due, 0, '上一拍还在跑就不叫');

  ticking = false;
  clock.fire();
  assert.equal(due, 1, '跑完了、排期还过期，才补这一拍');
});

test('插件关着 / 推后期没到 / 排期还没到：都不催', () => {
  const clock = fakeClock();
  let due = 0;
  const base = {
    now: clock.now,
    onDue: () => {
      due += 1;
    },
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  };
  const overdue = Date.parse('2026-11-11T13:02:21+08:00');

  createSafetyPoll({ ...base, isEnabled: () => false, nextRunAt: () => overdue }).check();
  createSafetyPoll({
    ...base,
    nextRunAt: () => overdue,
    retryAfterAt: () => Date.parse('2026-11-11T13:30:00+08:00'),
  }).check();
  createSafetyPoll({ ...base, nextRunAt: () => Date.parse('2026-11-11T13:06:00+08:00') }).check();
  createSafetyPoll({ ...base, nextRunAt: () => undefined }).check();

  assert.equal(due, 0);
});

test('stop 之后不再催；默认 25 秒一拍且 unref', () => {
  const clock = fakeClock();
  let due = 0;
  const poll = createSafetyPoll({
    nextRunAt: () => Date.parse('2026-11-11T13:02:21+08:00'),
    now: clock.now,
    onDue: () => {
      due += 1;
    },
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  poll.start();
  assert.equal(clock.intervals.length, 1);
  assert.equal(clock.intervals[0].ms, DEFAULT_SAFETY_INTERVAL_MS);
  assert.ok(DEFAULT_SAFETY_INTERVAL_MS <= 30_000, '25 秒级：丢拍后最多多等半分钟');
  poll.stop();
  assert.equal(clock.intervals.length, 0, 'dispose 要连 interval 一起收');
  poll.check();
  assert.equal(due, 0);
});

test('index.js 接线：rearm 排在 reconcile 之后，兜底轮询进 ctx.effect 收尾', async () => {
  const fs = await import('node:fs');
  const source = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/lifecycle.js', import.meta.url), 'utf8')].join('\n');
  // 切到 tick 模式时 port.drive('tick') 会 clearWake：先 arm 会被它清掉，所以 rearm 必须靠后
  assert.ok(
    source.indexOf('hourlyDriver.reconcile();') < source.indexOf('rearmFromState();'),
    'rearm 要排在 reconcile 之后，否则会被 drive(\'tick\') 的 clearWake 清掉',
  );
  assert.match(source, /createSafetyPoll\(\{/, '兜底轮询要真接进 apply');
  assert.match(source, /safetyPoll\.start\(\)/, '兜底轮询要 start');
  assert.match(source, /safetyPoll\.stop\(\)/, 'dispose 时要连兜底轮询一起收');
});
