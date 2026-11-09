/**
 * 状态文件的单测：TTL 过期、连败推后、读写往返（只碰临时目录）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultState,
  isExpired,
  prunePending,
  readState,
  recordFailure,
  recordSuccess,
  writeState,
} from '../lib/state.js';

const T0 = new Date('2026-11-08T06:50:00Z').getTime();

test('存着的话过了 TTL 就不再用', () => {
  const state = defaultState();
  state.pendingSayQueue = [{ id: 'p1', text: '要不要把备份清了', at: T0 }];
  state.pendingSeq = 1;
  const fresh = prunePending(state, T0 + 29 * 60 * 1000, 30);
  assert.equal(fresh.say?.text, '要不要把备份清了', '29 分钟还在');
  assert.equal(fresh.droppedSay, 0);

  const stale = prunePending(state, T0 + 30 * 60 * 1000, 30);
  assert.equal(stale.say, null, '正好 30 分钟算过期');
  assert.equal(stale.droppedSay, 1);
  assert.equal(state.pendingSayQueue.length, 0, '过期条目要从队列里摘掉');
});

test('存的票一样有 TTL，两条队列互不影响', () => {
  const state = defaultState();
  state.pendingTicketQueue = [{ id: 'p1', goal: '把 TODO 补完', brief: 'TODO', callId: 'proactive-2026-11-08-1', at: T0 }];
  state.pendingSayQueue = [{ id: 'p2', text: '还在', at: T0 }];
  state.pendingSeq = 2;
  const kept = prunePending(state, T0 + 60 * 1000, 30);
  assert.equal(kept.ticket?.callId, 'proactive-2026-11-08-1');
  assert.equal(kept.droppedTicket, 0);
  assert.equal(kept.droppedSay, 0);

  const gone = prunePending(state, T0 + 31 * 60 * 1000, 30);
  assert.equal(gone.ticket, null);
  assert.equal(gone.droppedTicket, 1);
  assert.equal(gone.droppedSay, 1, '话那条也一起过期了');
  assert.equal(state.pendingSayQueue.length + state.pendingTicketQueue.length, 0);
});

test('没写 at 的 pending 当过期，TTL 写 0 表示不过期', () => {
  assert.equal(isExpired({ text: 'x' }, T0, 30 * 60 * 1000), true);
  assert.equal(isExpired({ text: 'x', at: T0 }, T0 + 10 * 60 * 1000, 0), false);
  assert.equal(isExpired(null, T0, 30 * 60 * 1000), true);
});

test('连续失败 3 拍推后 60 分钟，成功清零', () => {
  const state = defaultState();
  recordFailure(state, T0, { maxFailStreak: 3, backoffMinutes: 60 });
  assert.equal(state.failStreak, 1);
  assert.equal(state.retryAfterAt, 0, '第一拍还不推');

  recordFailure(state, T0 + 1000, { maxFailStreak: 3, backoffMinutes: 60 });
  assert.equal(state.failStreak, 2);
  assert.equal(state.retryAfterAt, 0);

  recordFailure(state, T0 + 2000, { maxFailStreak: 3, backoffMinutes: 60 });
  assert.equal(state.failStreak, 3);
  assert.equal(state.retryAfterAt, T0 + 2000 + 60 * 60 * 1000, '第三拍推后 60 分钟');

  recordFailure(state, T0 + 3000, { maxFailStreak: 3, backoffMinutes: 60 });
  assert.equal(state.failStreak, 4);
  assert.equal(state.retryAfterAt, T0 + 3000 + 60 * 60 * 1000, '继续往后推');

  recordSuccess(state);
  assert.equal(state.failStreak, 0);
  assert.equal(state.retryAfterAt, 0);
});

test('状态读写：写坏了给默认值，写下去能读回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-state-'));
  const file = path.join(dir, 'nested', 'ego.state.json');
  const missing = readState(file);
  assert.equal(missing.nextRunAt, 0);
  assert.equal(missing.retryAfterAt, 0);

  const state = defaultState();
  state.targetSession = 'abc';
  state.failStreak = 2;
  state.pendingSayQueue = [{ id: 'p1', text: '你好', at: T0 }];
  state.pendingSeq = 1;
  assert.equal(writeState(file, state), true);
  const back = readState(file);
  assert.equal(back.targetSession, 'abc');
  assert.equal(back.failStreak, 2);
  assert.equal(back.pendingSayQueue[0].text, '你好');
  assert.equal(back.pendingSeq, 1, 'id 序号要跨进程留着，不然会重号');

  fs.writeFileSync(file, '{坏掉的 json', 'utf8');
  assert.equal(readState(file).failStreak, 0, '坏文件不抛，给默认值');
  fs.rmSync(dir, { recursive: true, force: true });
});
