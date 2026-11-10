/**
 * 开机自报闸门（announce-gate）的四条：就绪即发、兜底只发一次、会话不在活表时不发
 * 且落到兜底、任何一步抛错都不冒出去。
 *
 * 这里不碰真时钟：setTimeout / clearTimeout 都注入假的，fire 一次就等于「上限到了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ANNOUNCE_WAIT_MS, createAnnounceGate } from '../lib/announce-gate.js';

function fakeTimer() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** 手动烧掉所有还挂着的 timer，模拟「等够上限了」 */
    fire() {
      const list = [...timers.values()];
      timers.clear();
      for (const one of list) one.fn();
    },
    pending: () => timers.size,
    delays: () => [...timers.values()].map((one) => one.ms),
  };
}

function makeGate(overrides = {}) {
  const clock = overrides.clock ?? fakeTimer();
  const lines = [];
  const warns = [];
  const sends = [];
  const gate = createAnnounceGate({
    waitMs: overrides.waitMs ?? DEFAULT_ANNOUNCE_WAIT_MS,
    canSend: overrides.canSend ?? (() => true),
    trySend:
      overrides.trySend ??
      (async () => {
        sends.push('sent');
        return { ok: true };
      }),
    onQueued: overrides.onQueued ?? (() => {}),
    log: (line) => lines.push(line),
    warn: (line) => warns.push(line),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { gate, clock, lines, warns, sends };
}

test('就绪即发：agents 服务一到、目标会话在活表，立刻发一条，兜底 timer 被撤', async () => {
  const { gate, clock, lines, sends } = makeGate();
  gate.startFallback();
  assert.deepEqual(clock.delays(), [DEFAULT_ANNOUNCE_WAIT_MS], '先挂的是 10 秒兜底');
  assert.equal(gate.noteReady('agents 服务'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1, '就绪后只发一条');
  assert.equal(gate.settled, true);
  assert.equal(clock.pending(), 0, '发完就把兜底 timer 撤了');
  assert.ok(lines.some((line) => line.includes('立刻发')));
  // 事件连来两次也不会发第二条
  assert.equal(gate.noteReady('agents 服务'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
});

test('事件不来：到上限兜底发一次并 warn，之后再来事件也不补第二条', async () => {
  const { gate, clock, warns, sends } = makeGate({ waitMs: 10_000 });
  gate.startFallback();
  clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1, '兜底只发一次');
  assert.equal(gate.settled, true);
  assert.equal(gate.fallbacks, 1);
  assert.ok(
    warns.some((line) => line.includes('兜底') && line.includes('10000 毫秒')),
    `要有一条说明走了兜底的 warn，实际：${JSON.stringify(warns)}`,
  );
  // 兜底之后事件才来：不许再发
  assert.equal(gate.noteReady('agents 服务'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
});

test('目标会话不在活表：事件来了也不发，落到兜底再发一次', async () => {
  let inTable = false;
  const { gate, clock, warns, sends } = makeGate({
    canSend: () => inTable,
  });
  gate.startFallback();
  assert.equal(gate.noteReady('agents 服务'), false, '会话不在活表，就绪事件不该发');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 0);

  inTable = true; // 会话后来进了活表，但事件已经用完了
  clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1, '兜底走老路发一次');
  assert.ok(warns.some((line) => line.includes('兜底')));
});

test('发不出去（pending）：兜底会补一次；兜底自己也失败也只试一次，话留给 pending', async () => {
  let calls = 0;
  const { gate, clock, warns } = makeGate({
    trySend: async () => {
      calls += 1;
      return { ok: false, pending: true, reason: '会话不在活表' };
    },
  });
  gate.startFallback();
  gate.noteReady('agents 服务'); // 会话在活表（canSend 真），但 followup 那一刻又不在
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(gate.settled, false, '没发出去不算收口，还得等兜底');

  clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, '兜底补一次');
  assert.equal(gate.settled, true, '兜底试过就收口，别再反复发');
  assert.equal(gate.fallbacks, 1);
  assert.ok(warns.some((line) => line.includes('兜底')));
  assert.equal(clock.pending(), 0);
});

test('异常不抛：trySend 抛错只 warn；事件那条路不 settle，兜底照旧补一次', async () => {
  let calls = 0;
  const { gate, clock, warns } = makeGate({
    trySend: async () => {
      calls += 1;
      if (calls === 1) throw new Error('followup 炸了');
      return { ok: true };
    },
  });
  gate.startFallback();
  await assert.doesNotReject(async () => {
    gate.noteReady('agents 服务');
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(calls, 1);
  assert.equal(gate.settled, false);
  assert.ok(warns.some((line) => line.includes('开盘自报抛错') || line.includes('开机自报抛错')));

  clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(gate.settled, true, '兜底这次发成功就收口');
});

test('canSend 自己抛错也不冒出去，只 warn 并继续等兜底', async () => {
  const { gate, warns, sends } = makeGate({
    canSend: () => {
      throw new Error('agents 服务查不动');
    },
  });
  gate.startFallback();
  assert.equal(gate.noteReady('agents 服务'), false);
  assert.equal(sends.length, 0);
  assert.ok(warns.some((line) => line.includes('判断能不能发时抛错')));
  assert.equal(gate.settled, false);
});

test('兜底到点时事件那条还在发：不叠第二条，等它失败后兜底再补上', async () => {
  let resolveSend;
  let calls = 0;
  const { gate, clock } = makeGate({
    trySend: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => (resolveSend = resolve));
      return Promise.resolve({ ok: true });
    },
  });
  gate.startFallback();
  gate.noteReady('agents 服务'); // 开始发，followup 一直没回
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  clock.fire(); // 兜底到点，撞上「正在发」
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, '这个时刻不许叠第二条');
  assert.equal(gate.fallbacks, 0, '还没真走兜底');
  assert.equal(clock.pending(), 1, '重挂了一个短 timer 再看一眼');

  resolveSend({ ok: false, pending: true, reason: '会话不在活表' }); // 事件那条失败
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.settled, false, '失败不算收口');

  clock.fire(); // 重挂的那个到点，真走兜底
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(gate.fallbacks, 1);
  assert.equal(gate.settled, true);
});

test('dispose 之后事件和兜底都不再触发', async () => {
  const { gate, clock, sends } = makeGate();
  gate.startFallback();
  gate.dispose();
  assert.equal(clock.pending(), 0);
  clock.fire(); // fire 已经清空的表：什么都不该发生
  gate.noteReady('agents 服务');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 0);
});

test('兜底没发出去但话已排进队列：交给 onQueued 开补发盯梢，自己收口不再发第二条', async () => {
  const queued = [];
  const { gate, clock } = makeGate({
    trySend: async () => ({ ok: false, queued: true, pending: true, text: '醒了', reason: '会话不在活表' }),
    onQueued: (result) => queued.push(result),
  });
  gate.startFallback();
  clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queued.length, 1, '兜底 queued 的结果要交给补发盯梢');
  assert.equal(queued[0].text, '醒了');
  assert.equal(gate.settled, true, '闸门自己照旧收口，补发只走队列');
  assert.equal(clock.pending(), 0, '闸门不再挂 timer');
});

test('正常路径不受影响：就绪即发成功，onQueued 一次都不调', async () => {
  const queued = [];
  const { gate, sends } = makeGate({ onQueued: (result) => queued.push(result) });
  gate.startFallback();
  assert.equal(gate.noteReady('agents 服务'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1, '正常路径还是只发一条');
  assert.equal(queued.length, 0, '没排队列就不该开补发盯梢');
  assert.equal(gate.settled, true);
});
