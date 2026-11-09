/**
 * 存着的话/票的即时补发调度器：主会话一活跃就盯着，跑完变 idle 立刻补。
 * 时间源全注入，不真等 2 分钟。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_FLUSH_INTERVAL_MS, PENDING_FLUSH_TRIES, createPendingFlusher } from '../lib/flush.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeTimers() {
  const queue = [];
  return {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      queue.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      const at = queue.indexOf(handle);
      if (at >= 0) queue.splice(at, 1);
    },
    async runNext() {
      const next = queue.shift();
      assert.ok(next, '该排下一次却没排');
      next.fn();
      await tick();
    },
    get pending() {
      return queue.length;
    },
  };
}

test('没有存着的话/票：schedule 直接返回 false，一次都不重试', async () => {
  let calls = 0;
  const flusher = createPendingFlusher({
    retryPending: async () => {
      calls += 1;
    },
    hasPending: () => false,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });
  assert.equal(flusher.schedule(), false);
  await tick();
  assert.equal(calls, 0);
  assert.equal(flusher.flushing, false);
});

test('主会话刚说话：立刻试一次；pending 清空就收工，不再排下一次', async () => {
  const timers = fakeTimers();
  let pending = true;
  let calls = 0;
  const logs = [];
  const flusher = createPendingFlusher({
    retryPending: async () => {
      calls += 1;
      pending = false; // 这一轮发成功了
    },
    hasPending: () => pending,
    log: (line) => logs.push(line),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  assert.equal(flusher.schedule('主会话有动静'), true);
  await tick();
  assert.equal(calls, 1, '第一次不等 interval，立即试');
  assert.equal(flusher.flushing, false, '发出去就收工');
  assert.equal(timers.pending, 0, '成功了不该再排');
  assert.ok(logs.some((line) => line.includes('主会话有动静')));
});

test('主会话还在忙：按 interval 再试，忙完那一次补上', async () => {
  const timers = fakeTimers();
  let pending = true;
  let calls = 0;
  const flusher = createPendingFlusher({
    retryPending: async () => {
      calls += 1;
      if (calls >= 2) pending = false;
    },
    hasPending: () => pending,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  flusher.schedule();
  await tick();
  assert.equal(calls, 1);
  assert.equal(timers.pending, 1, '还存着就要排下一次');
  await timers.runNext();
  assert.equal(calls, 2, '隔 interval 秒再试');
  assert.equal(flusher.flushing, false);
});

test('一直忙：试满 tries 次就停手，交给每分钟那一拍', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const logs = [];
  const flusher = createPendingFlusher({
    retryPending: async () => {
      calls += 1;
    },
    hasPending: () => true,
    log: (line) => logs.push(line),
    intervalMs: 50,
    tries: 2,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  flusher.schedule();
  await tick();
  await timers.runNext();
  assert.equal(calls, 2);
  assert.equal(flusher.flushing, false);
  assert.equal(timers.pending, 0);
  assert.ok(logs.some((line) => line.includes('交给每分钟那一拍')), `实际日志：${logs.join(' | ')}`);
});

test('重入：已经在盯的时候再 schedule 不加一条', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const flusher = createPendingFlusher({
    retryPending: async () => {
      calls += 1;
    },
    hasPending: () => true,
    intervalMs: 50,
    tries: 10,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  flusher.schedule();
  assert.equal(flusher.schedule(), false, '第二次要拒掉');
  await tick();
  assert.equal(calls, 1);
  flusher.stop();
  assert.equal(flusher.flushing, false);
});

test('stop：清掉没跑的那一次', async () => {
  const timers = fakeTimers();
  let before = 0;
  const flusher = createPendingFlusher({
    retryPending: async () => {
      before += 1;
    },
    hasPending: () => true,
    intervalMs: 50,
    tries: 10,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  flusher.schedule();
  await tick();
  assert.equal(timers.pending, 1);
  flusher.stop();
  assert.equal(timers.pending, 0, 'stop 后不该再留定时器');
});

test('节奏常量：3 秒一次、40 次约 2 分钟', () => {
  assert.equal(PENDING_FLUSH_INTERVAL_MS, 3000);
  assert.equal(PENDING_FLUSH_TRIES, 40);
  assert.ok((PENDING_FLUSH_INTERVAL_MS * PENDING_FLUSH_TRIES) / 1000 >= 60);
});
