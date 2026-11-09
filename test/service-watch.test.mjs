/**
 * `internal/service` 监听（方案 a）：schedule 就绪就重挂规则，不等轮询。
 *
 * 四条：
 *   · 就绪事件一到就注册规则、切 tick，不用等 60 秒轮询；
 *   · reconcile 抛错被监听器吞掉，只 warn 不 rethrow（这条最要紧：events 的
 *     emit 不兜错，冒出去会弄挂 timer 的 apply）；
 *   · 销毁再就绪（热重载）能重挂回来；
 *   · serviceEventSeen 为假时 watchdog 收成 10 分钟巡检，顺手查规则还在不在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOURLY_RULE_ID,
  HOURLY_TOPIC,
  attachServiceWatch,
  createHourlyDriver,
} from '../lib/hourly-driver.js';

const T0 = Date.parse('2026-11-09T12:00:00+08:00');

function fakeClock(start = T0) {
  let now = start;
  const intervals = new Map();
  const intervalMs = [];
  let seq = 0;
  return {
    now: () => new Date(now),
    setInterval(fn, ms) {
      const id = ++seq;
      intervalMs.push(ms);
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    advance(ms) {
      now += ms;
    },
    intervalCount: () => intervals.size,
    lastIntervalMs: () => intervalMs[intervalMs.length - 1],
    fireIntervals() {
      for (const fn of [...intervals.values()]) fn();
    },
  };
}

function fakeEvents() {
  const defs = new Map();
  const subs = new Set();
  return {
    defineEvent(def) {
      defs.set(def.name, def);
      return def;
    },
    registry: { get: (name) => defs.get(name) },
    subscribe(pattern, handler) {
      const sub = { pattern, handler, stopped: false, stop() { sub.stopped = true; subs.delete(sub); } };
      subs.add(sub);
      return sub;
    },
    count: () => subs.size,
  };
}

function fakeSchedule() {
  const rules = new Map();
  const calls = { register: [], unregister: [] };
  const fake = {
    rules,
    calls,
    /** 规则表接口：watchdog 后路用 `list()` 查自己的规则还在不在。 */
    list: () => [...rules.values()],
    register(def) {
      calls.register.push(def);
      if (rules.has(def.id)) {
        const error = new Error('id 重复');
        error.code = 'DUP_RULE_ID';
        throw error;
      }
      rules.set(def.id, def);
      return { id: def.id, topic: def.topic };
    },
    unregister(id) {
      calls.unregister.push(id);
      return rules.delete(id);
    },
  };
  return fake;
}

/** 假 ctx：只记监听器、能按事件名派发；不假装 effect 的清理（摘监听单独测）。 */
function fakeCtx() {
  const entries = [];
  return {
    entries,
    on(event, listener) {
      const entry = { event, listener, off: false };
      entries.push(entry);
      return () => {
        entry.off = true;
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    emit(event, ...args) {
      for (const entry of [...entries]) {
        if (!entry.off && entry.event === event) entry.listener(...args);
      }
    },
    count: (event) => entries.filter((entry) => entry.event === event).length,
  };
}

function makeDriver({ clock = fakeClock(), events = fakeEvents(), schedule = () => undefined, periodMs } = {}) {
  const drives = [];
  const warns = [];
  const driver = createHourlyDriver({
    port: {
      pulse: () => true,
      drive(source) {
        drives.push(source);
      },
    },
    events: () => events,
    schedule: typeof schedule === 'function' ? schedule : () => schedule,
    periodMs,
    clock,
    info: () => {},
    warn: (message) => warns.push(message),
  });
  return { driver, drives, warns, clock, events };
}

test('schedule 就绪事件一到就重挂规则、切 tick，不等 60 秒轮询', () => {
  const schedule = fakeSchedule();
  const ctx = fakeCtx();
  let ref;
  const { driver, drives } = makeDriver({ schedule: () => ref });
  attachServiceWatch(ctx, driver, { warn: () => {} });

  // 装载那一刻 schedule 还没来：只有自己的定时器，一条规则都没注册。
  driver.reconcile();
  assert.equal(schedule.calls.register.length, 0);
  assert.equal(driver.mode(), 'interval');

  // 服务一提供，事件就到——不调 onPoll，直接重挂。
  ref = schedule;
  ctx.emit('internal/service', 'schedule', schedule);

  assert.equal(schedule.calls.register.length, 1);
  assert.deepEqual(schedule.calls.register[0].id, HOURLY_RULE_ID);
  assert.equal(schedule.rules.get(HOURLY_RULE_ID).topic, HOURLY_TOPIC);
  assert.equal(driver.mode(), 'tick');
  assert.equal(driver.status().registered, true);
  assert.equal(driver.status().serviceEventSeen, true);
  assert.deepEqual(drives, ['tick']);
});

test('监听器里 reconcile 抛错：被吞掉、只 warn，不 rethrow', () => {
  const ctx = fakeCtx();
  const warns = [];
  const driver = {
    noteServiceEvent: () => true,
    reconcile() {
      throw new Error('boom from reconcile');
    },
  };
  attachServiceWatch(ctx, driver, { warn: (message) => warns.push(message) });

  // 宿主 emit 不兜错：这里要是 rethrow 就等价于把 timer 的 apply 弄挂。
  assert.doesNotThrow(() => ctx.emit('internal/service', 'schedule', {}));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /boom from reconcile/);
  assert.match(warns[0], /internal\/service/);
});

test('别的服务事件不碰 driver；摘监听后不再响应', () => {
  const ctx = fakeCtx();
  const calls = [];
  const driver = {
    noteServiceEvent(name, value) {
      calls.push(['note', name, value]);
      return name === 'schedule' && Boolean(value);
    },
    reconcile() {
      calls.push(['reconcile']);
    },
  };
  const off = attachServiceWatch(ctx, driver, { warn: () => {} });
  ctx.emit('internal/service', 'events', {});
  assert.deepEqual(calls, []);
  ctx.emit('internal/service', 'schedule', undefined);
  assert.deepEqual(calls, [['note', 'schedule', undefined]]);
  off();
  assert.equal(ctx.count('internal/service'), 0);
  ctx.emit('internal/service', 'schedule', {});
  assert.deepEqual(calls, [['note', 'schedule', undefined]]);
});

test('schedule 销毁再就绪（热重载）：规则在新实例上重挂回来', () => {
  const first = fakeSchedule();
  const second = fakeSchedule();
  const ctx = fakeCtx();
  let ref = first;
  const { driver } = makeDriver({ schedule: () => ref });
  attachServiceWatch(ctx, driver, { warn: () => {} });
  ctx.emit('internal/service', 'schedule', first);
  assert.equal(first.rules.has(HOURLY_RULE_ID), true);

  // 旧实例销毁：只清缓存标记，别起 60 秒轮询（drives 不该多一条 interval）。
  ctx.emit('internal/service', 'schedule', undefined);
  assert.equal(driver.status().registered, false);
  assert.equal(driver.mode(), 'tick', '销毁时不立刻降级，等服务再来');

  // 新实例就绪：规则重挂在新实例上。
  ref = second;
  ctx.emit('internal/service', 'schedule', second);
  assert.equal(second.rules.has(HOURLY_RULE_ID), true);
  assert.equal(second.calls.register.length, 1);
  assert.equal(first.calls.register.length, 1);
  assert.equal(driver.status().registered, true);
});

test('serviceEventSeen 为假：watchdog 收成 10 分钟巡检，并顺手把丢掉的规则重挂', () => {
  const schedule = fakeSchedule();
  const clock = fakeClock();
  const ctx = fakeCtx();
  const { driver, drives, warns } = makeDriver({ clock, schedule });
  attachServiceWatch(ctx, driver, { warn: () => {} }); // 挂了监听但事件一次没来
  driver.reconcile();
  assert.equal(driver.mode(), 'tick');
  assert.equal(driver.status().watchAttached, true);
  assert.equal(driver.status().serviceEventSeen, false);

  // 事件一次没来过：watchdog 睁眼间隔是 10 分钟，不是 1 小时。
  assert.equal(clock.lastIntervalMs(), 10 * 60_000);

  // 规则被谁 unregister 掉了（服务还在，对象没换）：10 分钟后这一眼要补上。
  schedule.rules.delete(HOURLY_RULE_ID);
  clock.advance(10 * 60_000);
  clock.fireIntervals();
  assert.equal(schedule.rules.has(HOURLY_RULE_ID), true);
  assert.equal(driver.status().registered, true);
  // 规则补回来了就先不走断流降级。
  assert.deepEqual(drives, ['tick']);
  assert.deepEqual(warns, []);

  // 再过一个 10 分钟仍然没有 tick：判死、退回自己的定时器。
  clock.advance(10 * 60_000);
  clock.fireIntervals();
  assert.deepEqual(drives, ['tick', 'interval']);
  assert.equal(driver.mode(), 'interval');
  assert.match(warns[0], /断流/);
});

test('收到过 service 事件：watchdog 回慢档，3 个整点才判死', () => {
  const schedule = fakeSchedule();
  const clock = fakeClock();
  const ctx = fakeCtx();
  const { driver, drives } = makeDriver({ clock, schedule });
  attachServiceWatch(ctx, driver, { warn: () => {} });
  ctx.emit('internal/service', 'schedule', schedule);
  assert.equal(driver.status().serviceEventSeen, true);

  assert.equal(clock.lastIntervalMs(), 60 * 60_000);
  clock.advance(2 * 60 * 60_000);
  clock.fireIntervals();
  assert.equal(driver.mode(), 'tick', '两个整点不算断流');
  clock.advance(2 * 60 * 60_000);
  clock.fireIntervals();
  assert.deepEqual(drives, ['tick', 'interval']);
});
