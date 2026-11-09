/**
 * 整点主拍驱动源的单测：正常订阅驱动 + 四类降级。
 *
 * 四类降级各来一条：
 *   · schedule 服务不在；
 *   · 注册被拒（EV-006）；
 *   · 服务中途消失（events / schedule 被撤）；
 *   · tick 断流 3 拍。
 * 每一条都必须回落到自己的定时器并 warn，不能静默停摆，也不能两路同时驱动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOURLY_CRON,
  HOURLY_RULE_ID,
  HOURLY_SUBSCRIBER_ID,
  HOURLY_TOPIC,
  HOURLY_EVENT_DEF,
  createHourlyDriver,
} from '../lib/hourly-driver.js';

const T0 = Date.parse('2026-11-09T12:00:00+08:00');

function fakeClock(start = T0) {
  let now = start;
  const intervals = new Map();
  let seq = 0;
  return {
    now: () => new Date(now),
    setInterval(fn) {
      const id = ++seq;
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
    fireIntervals() {
      for (const fn of [...intervals.values()]) fn();
    },
  };
}

function fakeEvents() {
  const defs = new Map();
  const subs = new Set();
  const calls = { define: [], subscribe: [] };
  return {
    calls,
    defineEvent(def) {
      calls.define.push(def);
      defs.set(def.name, def);
      return def;
    },
    registry: {
      get: (name) => defs.get(name),
      has: (name) => defs.has(name),
    },
    subscribe(pattern, handler, opts) {
      calls.subscribe.push({ pattern, opts });
      const sub = {
        pattern,
        stopped: false,
        stop() {
          sub.stopped = true;
          subs.delete(sub);
        },
      };
      sub.handler = handler;
      subs.add(sub);
      return sub;
    },
    deliver(payload) {
      for (const sub of [...subs]) sub.handler({ payload });
    },
    count: () => subs.size,
  };
}

function fakeSchedule({ failCode } = {}) {
  const rules = new Map();
  const calls = { register: [], unregister: [] };
  return {
    rules,
    calls,
    register(def) {
      calls.register.push(def);
      if (failCode) {
        const error = new Error(failCode === 'EV-006' ? '定时规则引用了未注册的 topic' : '注册失败');
        error.code = failCode;
        throw error;
      }
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
}

function makeDriver({ clock = fakeClock(), events, schedule, periodMs } = {}) {
  const drives = [];
  const pulses = [];
  const warns = [];
  const eventsService = events === undefined ? fakeEvents() : events;
  const scheduleService = schedule === undefined ? fakeSchedule() : schedule;
  const driver = createHourlyDriver({
    port: {
      pulse(source, payload) {
        pulses.push({ source, payload });
        return true;
      },
      drive(source) {
        drives.push(source);
      },
    },
    events: () => (typeof eventsService === 'function' ? eventsService() : eventsService),
    schedule: () => (typeof scheduleService === 'function' ? scheduleService() : scheduleService),
    periodMs,
    clock,
    info: () => {},
    warn: (message) => warns.push(message),
  });
  return { driver, drives, pulses, warns, clock, eventsService, scheduleService };
}

test('事件类型：volatile、version 1、payload 三个字段都要字符串', () => {
  assert.equal(HOURLY_EVENT_DEF.name, HOURLY_TOPIC);
  assert.equal(HOURLY_TOPIC, 'ego.hourly.tick');
  assert.equal(HOURLY_RULE_ID, 'ego.hourly');
  assert.equal(HOURLY_CRON, '0 * * * *');
  assert.equal(HOURLY_EVENT_DEF.version, 1);
  assert.equal(HOURLY_EVENT_DEF.durability, 'volatile');
  const ok = { name: 'ego.hourly.tick', firedAt: '2026-11-09T12:00:00.000Z', periodKey: 'ego.hourly.hourly.2026-11-09T20' };
  assert.equal(HOURLY_EVENT_DEF.payloadSchema(ok), true);
  assert.equal(HOURLY_EVENT_DEF.payloadSchema({ ...ok, periodKey: undefined }), false);
  assert.equal(HOURLY_EVENT_DEF.payloadSchema({ ...ok, firedAt: 1 }), false);
  assert.equal(HOURLY_EVENT_DEF.payloadSchema(undefined), false);
});

test('正常路径：defineEvent → subscribe → register，注册成功才停自己的定时器', () => {
  const events = fakeEvents();
  const schedule = fakeSchedule();
  const { driver, drives, pulses, warns } = makeDriver({ events, schedule });

  driver.reconcile();
  driver.reconcile(); // 幂等：不许挂第二份订阅/规则

  assert.equal(events.calls.define.length, 1);
  assert.deepEqual(events.calls.subscribe.map((one) => one.pattern), [HOURLY_TOPIC]);
  assert.equal(events.calls.subscribe[0].opts.subscriberId, HOURLY_SUBSCRIBER_ID);
  assert.deepEqual(events.calls.subscribe[0].opts.replay, { mode: 'none' });
  assert.equal(schedule.calls.register.length, 1);
  assert.deepEqual(schedule.calls.register[0], {
    id: HOURLY_RULE_ID,
    cron: HOURLY_CRON,
    topic: HOURLY_TOPIC,
    catchUp: 'skip',
  });
  assert.deepEqual(drives, ['tick'], '切到 tick 后自己的定时器要停（drive 只被叫一次）');
  assert.deepEqual(driver.status().mode, 'tick');
  assert.equal(driver.status().subscribed, true);
  assert.equal(driver.status().registered, true);
  assert.deepEqual(warns, []);

  // tick 来了就打到 port，业务逻辑不看驱动源
  const payload = { name: HOURLY_TOPIC, firedAt: '2026-11-09T12:00:00+08:00', periodKey: 'ego.hourly.hourly.2026-11-09T20' };
  events.deliver(payload);
  assert.equal(pulses.length, 1);
  assert.equal(pulses[0].source, 'tick');
  assert.deepEqual(pulses[0].payload, payload);
});

test('降级一：schedule 服务不在，保留自己的定时器，只播报一次', () => {
  const events = fakeEvents();
  const { driver, drives, warns } = makeDriver({ events, schedule: () => undefined });

  driver.reconcile();
  driver.reconcile();

  assert.equal(driver.mode(), 'interval');
  assert.deepEqual(drives, [], '没切换过，自己的定时器原样跑');
  assert.equal(events.count(), 1, '订阅可以先挂着，等 schedule 出现');
  assert.equal(warns.length, 1, '同一件事只播报一次，别刷屏');
  assert.match(warns[0], /schedule 服务尚未就绪/);
});

test('降级一续：schedule 服务中途出现，下一次 reconcile 就切过去', () => {
  let scheduleService;
  const events = fakeEvents();
  const { driver, drives } = makeDriver({ events, schedule: () => scheduleService });
  driver.reconcile();
  assert.equal(driver.mode(), 'interval');

  scheduleService = fakeSchedule();
  driver.reconcile();
  assert.equal(driver.mode(), 'tick');
  assert.deepEqual(drives, ['tick']);
  assert.equal(scheduleService.rules.has(HOURLY_RULE_ID), true);
});

test('降级二：注册抛 EV-006，保留自己的定时器并 warn，冷却期内不重试', () => {
  const events = fakeEvents();
  const schedule = fakeSchedule({ failCode: 'EV-006' });
  const { driver, drives, warns, clock } = makeDriver({ events, schedule });

  driver.reconcile();
  assert.equal(driver.mode(), 'interval');
  assert.deepEqual(drives, []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /EV-006/);

  driver.reconcile();
  assert.equal(schedule.calls.register.length, 1, '冷却期内别再撞同一堵墙');

  clock.advance(31 * 60 * 1000);
  driver.reconcile();
  assert.equal(schedule.calls.register.length, 2, '冷却过了要再试一次');
});

test('降级三：tick 模式下 schedule 服务中途消失，退回自己的定时器并退订 + 注销', () => {
  let scheduleService = fakeSchedule();
  const events = fakeEvents();
  const { driver, drives, warns, clock } = makeDriver({ events, schedule: () => scheduleService });
  driver.reconcile();
  assert.equal(driver.mode(), 'tick');
  const sub = [...events.calls.subscribe];
  assert.equal(sub.length, 1);

  scheduleService = undefined;
  clock.advance(1000);
  driver.tick({ name: HOURLY_TOPIC, firedAt: new Date().toISOString(), periodKey: 'k1' });

  assert.equal(driver.mode(), 'interval');
  assert.deepEqual(drives, ['tick', 'interval']);
  assert.equal(events.count(), 0, '退订要真退掉');
  assert.match(warns.at(-1), /schedule 服务不在了/);
  assert.match(warns.at(-1), /恢复自己的 60 秒定时器/);
});

test('降级三续：events 服务中途消失，同样退回自己的定时器', () => {
  let eventsService = fakeEvents();
  const schedule = fakeSchedule();
  const { driver, drives, warns } = makeDriver({ events: () => eventsService, schedule });
  driver.reconcile();
  assert.equal(driver.mode(), 'tick');

  eventsService = undefined;
  driver.reconcile();
  assert.equal(driver.mode(), 'interval');
  assert.deepEqual(drives, ['tick', 'interval']);
  assert.match(warns.at(-1), /events 服务不在了/);
});

test('降级四：tick 断流 3 拍，退订 + 注销 + 恢复自己的定时器并 warn', () => {
  const schedule = fakeSchedule();
  const events = fakeEvents();
  const { driver, drives, warns, clock } = makeDriver({ events, schedule });
  driver.reconcile();
  assert.equal(driver.mode(), 'tick');
  assert.equal(schedule.rules.has(HOURLY_RULE_ID), true);

  clock.advance(2 * 60 * 60 * 1000);
  clock.fireIntervals();
  assert.equal(driver.mode(), 'tick', '才两拍，还没到断流线');

  clock.advance(60 * 60 * 1000);
  clock.fireIntervals();
  assert.equal(driver.mode(), 'interval');
  assert.deepEqual(drives, ['tick', 'interval']);
  assert.equal(events.count(), 0, '断流要退订，别留一份收不到东西的订阅');
  assert.deepEqual(schedule.calls.unregister, [HOURLY_RULE_ID], '断流要把规则也撤了');
  assert.match(warns.at(-1), /断流/);
  assert.match(warns.at(-1), /恢复自己的 60 秒定时器/);
  assert.equal(clock.intervalCount(), 0, 'watchdog 也要停，别空转');
});

test('tick 模式下 schedule 换了实例：规则在新实例上重挂，不换源', () => {
  let scheduleService = fakeSchedule();
  const events = fakeEvents();
  const { driver, drives } = makeDriver({ events, schedule: () => scheduleService });
  driver.reconcile();
  assert.equal(driver.mode(), 'tick');

  scheduleService = fakeSchedule();
  driver.reconcile();
  assert.equal(driver.mode(), 'tick');
  assert.equal(scheduleService.rules.has(HOURLY_RULE_ID), true, '新实例上要重挂');
  assert.deepEqual(drives, ['tick'], '还在 tick 模式，不该再换一次源');
});

test('dispose：退订、注销规则、停 watchdog，不留尾巴', () => {
  const schedule = fakeSchedule();
  const events = fakeEvents();
  const { driver, clock } = makeDriver({ events, schedule });
  driver.reconcile();
  assert.equal(driver.mode(), 'tick');
  assert.equal(clock.intervalCount(), 1);

  driver.dispose();
  assert.equal(driver.mode(), 'interval');
  assert.equal(events.count(), 0);
  assert.deepEqual(schedule.calls.unregister, [HOURLY_RULE_ID]);
  assert.equal(clock.intervalCount(), 0);

  driver.reconcile();
  assert.equal(driver.mode(), 'interval', '收摊后 reconcile 不许再切回去');
});
