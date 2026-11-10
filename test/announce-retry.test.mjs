/**
 * 开机自报「兜底没发出去 → 会话就绪后补发一次」的可靠性用例。
 *
 * 覆盖四件事：
 *   1. 兜底到点时会话不在活表，话在队列里；会话后来进活表，补发一次；
 *   2. 补发过一次就收口，后面再怎么 tick 都不会发第二次；
 *   3. 正常路径（就绪即发）不受影响：不排队列、不开盯梢（见 announce-gate.test.mjs）；
 *   4. pendingSayQueue 落盘再读回（模拟进程重启）仍然能补发，补完落盘是空的。
 *
 * 这里不碰真时钟：setTimeout / clearTimeout / now 全部注入假的，advance() 手动推进。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ANNOUNCE_RETRY_INTERVAL_MS,
  DEFAULT_ANNOUNCE_RETRY_WINDOW_MS,
  announceRetryWindowMs,
  createAnnounceRetry,
} from '../lib/announce-retry.js';
import { defaultState, readState, writeState } from '../lib/state.js';
import { ackPendingByKey, enqueuePending, hasPendingText } from '../lib/pending-queue.js';

const BOOT_TEXT = 'dsh-ego 1.0.0 刚重启完，先看有没有该验的事，有就去做，没有就跟主人打句招呼，短。';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock(startMs = 1_700_000_000_000) {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: nowMs + Number(ms || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** 推进时间：按到期顺序把 timer 跑完，每跑一个都让 Promise 链走一步 */
    async advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        let nextId;
        let next;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === undefined || timer.at < next.at)) {
            nextId = id;
            next = timer;
          }
        }
        if (next === undefined) break;
        timers.delete(nextId);
        nowMs = next.at;
        next.fn();
        await flush();
      }
      nowMs = target;
      await flush();
    },
    pending: () => timers.size,
  };
}

function makeRetry(overrides = {}) {
  const clock = overrides.clock ?? fakeClock();
  const lines = [];
  const warns = [];
  const retry = createAnnounceRetry({
    windowMs: overrides.windowMs ?? DEFAULT_ANNOUNCE_RETRY_WINDOW_MS,
    intervalMs: ANNOUNCE_RETRY_INTERVAL_MS,
    canSend: overrides.canSend ?? (() => true),
    hasPending: overrides.hasPending,
    retryPending: overrides.retryPending,
    log: (line) => lines.push(line),
    warn: (line) => warns.push(line),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  return { retry, clock, lines, warns };
}

test('到点时不在活表：会话后来进活表，补发一次就收口', async () => {
  const clock = fakeClock();
  let alive = false;
  let pending = true;
  let retries = 0;
  const { retry, lines } = makeRetry({
    clock,
    canSend: () => alive,
    hasPending: () => pending,
    retryPending: async () => {
      retries += 1;
      pending = false; // 等价于 ask 发成功、ackPendingByKey 把那条删掉
    },
  });

  assert.equal(retry.start(), true, '话在队列里，就该开盯梢');
  await clock.advance(5_000);
  assert.equal(retries, 0, '会话不在活表，不许硬发');
  assert.equal(retry.active, true);

  alive = true; // warmup 把会话写进活表
  await clock.advance(ANNOUNCE_RETRY_INTERVAL_MS);
  assert.equal(retries, 1, '会话一进活表就补发一次');
  assert.equal(retry.active, false, '补发成功就收口');
  assert.equal(clock.pending(), 0, '收口后不再挂 timer');
  assert.ok(lines.some((line) => line.includes('补发出去了')));
});

test('补发过一次后不再补发第二次：时间再走、再 start 都不行', async () => {
  const clock = fakeClock();
  let retries = 0;
  let pending = true;
  const { retry } = makeRetry({
    clock,
    canSend: () => true,
    hasPending: () => pending,
    retryPending: async () => {
      retries += 1;
      pending = false;
    },
  });

  retry.start();
  await flush();
  assert.equal(retries, 1);
  assert.equal(retry.active, false);

  await clock.advance(10 * 60_000);
  assert.equal(retries, 1, '收口后隔多久都不许再发');
  assert.equal(retry.start(), false, '队列里已经没有这句，start 直接拒绝');
  await flush();
  assert.equal(retries, 1);
});

test('补发时目标会话又变忙：这句留在队列里，窗口内继续等，不会重复发', async () => {
  const clock = fakeClock();
  let retries = 0;
  let pending = true;
  let sends = 0;
  const { retry } = makeRetry({
    clock,
    canSend: () => true,
    hasPending: () => pending,
    retryPending: async () => {
      retries += 1;
      // 第一下撞上「正忙」，队列原样留着；第二下才真发出去
      if (retries >= 2) {
        sends += 1;
        pending = false;
      }
    },
  });

  retry.start();
  await flush(); // 先让第一下 retryPending 走完、timer 挂上
  await clock.advance(3 * ANNOUNCE_RETRY_INTERVAL_MS);
  assert.equal(retries, 2, '第一下没发出去就 1 秒后再试，发成功即收口');
  assert.equal(sends, 1);
  assert.equal(pending, false);
  assert.equal(retry.active, false);
});

test('窗口到了还没等到会话：warn 一条交给每拍重试，话不丢', async () => {
  const clock = fakeClock();
  let retries = 0;
  let pending = true;
  const { retry, warns } = makeRetry({
    clock,
    windowMs: 3_000,
    canSend: () => false,
    hasPending: () => pending,
    retryPending: async () => {
      retries += 1;
    },
  });

  retry.start();
  await clock.advance(3_000);
  assert.equal(retries, 0);
  assert.equal(retry.active, false, '窗口到点收口，交给每拍重试');
  assert.equal(pending, true, '队列里那句还在，没被这里丢掉');
  assert.ok(
    warns.some((line) => line.includes('补发窗口') && line.includes('pending 重试')),
    `要 warn 一条说明交给了每拍重试，实际：${JSON.stringify(warns)}`,
  );
});

test('pendingSayQueue 落盘再读回（模拟重启）仍能补发，补完落盘为空', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-announce-retry-'));
  const file = path.join(dir, 'state.json');
  try {
    const state = defaultState();
    enqueuePending(state, 'say', { text: BOOT_TEXT, at: 1_700_000_000_000 });
    assert.equal(writeState(file, state), true);

    // 进程重启：只从磁盘读回来
    const revived = readState(file);
    assert.equal(revived.pendingSayQueue.length, 1, '落盘的那句要读得回来');
    assert.equal(hasPendingText(revived, 'say', BOOT_TEXT), true);

    const clock = fakeClock();
    let sent = 0;
    const { retry } = makeRetry({
      clock,
      canSend: () => true,
      hasPending: () => hasPendingText(revived, 'say', BOOT_TEXT),
      retryPending: async () => {
        sent += 1;
        // 等价于 ask 发成功：ack 掉同文本那条并落盘
        ackPendingByKey(revived, 'say', { text: BOOT_TEXT });
        writeState(file, revived);
      },
    });

    retry.start();
    await clock.advance(5 * ANNOUNCE_RETRY_INTERVAL_MS);
    assert.equal(sent, 1, '读回来的那条只补发一次');
    assert.equal(hasPendingText(revived, 'say', BOOT_TEXT), false);

    const after = readState(file);
    assert.deepEqual(after.pendingSayQueue, [], '补发成功要落盘，重启后不会再发第二遍');
    assert.equal(after.pendingSeq, revived.pendingSeq, '序号跟着落盘，id 不会回退');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('窗口配置：默认 30 秒，0 = 不盯，负数/非数字退回默认', async () => {
  assert.equal(DEFAULT_ANNOUNCE_RETRY_WINDOW_MS, 30_000);
  assert.equal(ANNOUNCE_RETRY_INTERVAL_MS, 1_000);
  assert.equal(announceRetryWindowMs(30_000), 30_000);
  assert.equal(announceRetryWindowMs(0), 0, '0 是合法的「不盯」');
  assert.equal(announceRetryWindowMs(-1), 30_000);
  assert.equal(announceRetryWindowMs('abc'), 30_000);
  assert.equal(announceRetryWindowMs(undefined), 30_000);

  let retries = 0;
  const { retry, lines } = makeRetry({
    windowMs: 0,
    hasPending: () => true,
    retryPending: async () => {
      retries += 1;
    },
  });
  assert.equal(retry.start(), false);
  assert.equal(retries, 0);
  assert.ok(lines.some((line) => line.includes('不盯')));
});

test('没有待发条目时 start 直接拒绝：不会盯一个空队列', async () => {
  const clock = fakeClock();
  let retries = 0;
  const { retry, lines } = makeRetry({
    clock,
    hasPending: () => false,
    retryPending: async () => {
      retries += 1;
    },
  });
  assert.equal(retry.start(), false);
  assert.equal(retry.active, false);
  assert.equal(clock.pending(), 0);
  assert.equal(retries, 0);
  assert.ok(lines.some((line) => line.includes('不在待发队列')));
});
