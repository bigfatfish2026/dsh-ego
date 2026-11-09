/**
 * 真机暴露的问题：ego 比 dsh-timer 先 apply，`schedule` 还没提供，驱动源停在
 * 自己的 60 秒定时器上；之后一直不重探，要等 nextRunAt 那次真拍才 reconcile，
 * 于是 dsh-timer 的规则表里长时间只有 dispatcher.sweep，没有 ego.hourly。
 *
 * 根因：60 秒轮询直接调 tick()，从不经 port.pulse('interval')，reconcile 只在
 * 收到整点 tick 时才跑——没有 tick 就永远等不到 tick。
 *
 * 修法：每拍先 onPoll → reconcile（轻量：只读服务句柄与本地标记）→ 还停在
 * interval 才跑真拍。这两条把真机的时序原样演一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOURLY_RULE_ID,
  HOURLY_TOPIC,
  createHourlyDriver,
} from '../lib/hourly-driver.js';

const T0 = Date.parse('2026-11-09T12:00:00+08:00');
const POLL_MS = 60 * 1000;

function fakeClock(start = T0) {
  let now = start;
  const intervals = new Map();
  let seq = 0;
  return {
    now: () => new Date(now),
    setInterval(fn, ms) {
      const id = ++seq;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    advance(ms) {
      now += ms;
    },
    /** 只数 60 秒轮询：watchdog 是 1 小时一拍，别混进来。 */
    pollCount: () => [...intervals.values()].filter((one) => one.ms === POLL_MS).length,
    intervalCount: () => intervals.size,
    firePoll() {
      for (const one of [...intervals.values()]) {
        if (one.ms === POLL_MS) one.fn();
      }
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
        stop() {
          subs.delete(sub);
        },
      };
      subs.add(sub);
      return sub;
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
        const error = new Error('注册失败');
        error.code = failCode;
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

/** 复刻 index.js 的接线：drive('interval') 起 60 秒轮询，drive('tick') 停掉它。 */
function makeRig({ events, schedule }) {
  const clock = fakeClock();
  const drives = [];
  const pulses = [];
  const warns = [];
  const infos = [];
  let pollHandle;
  let driver;

  function startPoll() {
    if (pollHandle !== undefined) return;
    pollHandle = clock.setInterval(() => driver.onPoll(), POLL_MS);
  }

  function stopPoll() {
    if (pollHandle === undefined) return;
    clock.clearInterval(pollHandle);
    pollHandle = undefined;
  }

  driver = createHourlyDriver({
    port: {
      pulse(source, payload) {
        pulses.push({ source, payload });
        return true;
      },
      drive(source) {
        drives.push(source);
        if (source === 'tick') stopPoll();
        else startPoll();
      },
    },
    events: () => (typeof events === 'function' ? events() : events),
    schedule: () => (typeof schedule === 'function' ? schedule() : schedule),
    clock,
    info: (message) => infos.push(message),
    warn: (message) => warns.push(message),
  });

  return { driver, clock, drives, pulses, warns, infos, startPoll, stopPoll };
}

test('schedule 晚到：下一次轮询就切到 tick，旧定时器停掉，规则注册上', () => {
  const events = fakeEvents();
  let scheduleService;
  const rig = makeRig({ events, schedule: () => scheduleService });

  // ego 先 apply：装载时探一次，schedule 不在，退回自己的定时器（index 里 startPoll）
  rig.driver.reconcile();
  rig.startPoll();
  assert.equal(rig.driver.mode(), 'interval');
  assert.equal(rig.clock.pollCount(), 1);
  assert.equal(rig.warns.length, 1);
  assert.match(rig.warns[0], /schedule 服务尚未就绪/);

  // 第一拍：schedule 还没来，只探、照常跑真拍
  rig.clock.advance(POLL_MS);
  rig.clock.firePoll();
  assert.equal(rig.driver.mode(), 'interval');
  assert.equal(rig.pulses.length, 1);
  assert.equal(rig.pulses[0].source, 'interval');
  assert.equal(events.calls.subscribe.length, 1, '订阅只挂一份，不许每拍重挂');

  // dsh-timer 挂上了：下一拍就该发现，不必等 nextRunAt 那次真拍
  scheduleService = fakeSchedule();
  rig.clock.advance(POLL_MS);
  rig.clock.firePoll();

  assert.equal(rig.driver.mode(), 'tick');
  assert.deepEqual(rig.drives, ['tick'], '切源只切一次');
  assert.equal(rig.clock.pollCount(), 0, '切到 tick 后 60 秒轮询要真停掉');
  assert.equal(scheduleService.rules.has(HOURLY_RULE_ID), true, '规则表里要有 ego.hourly');
  assert.equal(scheduleService.calls.register.length, 1);
  assert.equal(scheduleService.calls.register[0].topic, HOURLY_TOPIC);
  assert.equal(rig.pulses.length, 1, '切换那一拍不跑真拍，排期交给整点 tick');
  assert.equal(rig.clock.intervalCount(), 1, '只剩 watchdog');
});

test('schedule 一直不来：每拍只探不注册，日志只 warn 一次，真拍照跑', () => {
  const events = fakeEvents();
  const rig = makeRig({ events, schedule: () => undefined });

  rig.driver.reconcile();
  rig.startPoll();
  assert.equal(rig.warns.length, 1);

  for (let i = 0; i < 3; i += 1) {
    rig.clock.advance(POLL_MS);
    rig.clock.firePoll();
  }

  assert.equal(rig.driver.mode(), 'interval');
  assert.deepEqual(rig.drives, [], '没切过源');
  assert.equal(rig.pulses.length, 3, '外表看还是每分钟一拍，跟旧主拍一致');
  assert.deepEqual(rig.pulses.map((one) => one.source), ['interval', 'interval', 'interval']);
  assert.equal(rig.warns.length, 1, '同一件事只播报一次，别每拍刷屏');
  assert.equal(events.calls.subscribe.length, 1, '订阅一份就够，每拍重挂就成垃圾了');
});

test('每拍 reconcile 不破坏冷却：注册被拒后 30 分钟内不撞第二次', () => {
  const events = fakeEvents();
  const schedule = fakeSchedule({ failCode: 'EV-006' });
  const rig = makeRig({ events, schedule });

  rig.driver.reconcile();
  rig.startPoll();
  for (let i = 0; i < 3; i += 1) {
    rig.clock.advance(POLL_MS);
    rig.clock.firePoll();
  }
  assert.equal(schedule.calls.register.length, 1, '冷却期内每拍探也不许重注册');
  assert.equal(rig.warns.length, 1);

  rig.clock.advance(31 * 60 * 1000);
  rig.clock.firePoll();
  assert.equal(schedule.calls.register.length, 2, '冷却过了下一拍就该再试');
});
