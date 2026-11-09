/**
 * pending 队列的单测：空的、一条、满上限、连续追加后逐条取，四种情况都在这里。
 * 纯模块，不碰磁盘（除了最后那条重启往返，用临时目录）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PENDING_LIMIT,
  ackPending,
  ackPendingByKey,
  enqueuePending,
  findPendingTicketByContent,
  hasPendingItems,
  migrateLegacyPending,
  pendingCount,
  pendingHead,
  pruneQueue,
} from '../lib/pending-queue.js';
import { defaultState, isExpired, readState, writeState } from '../lib/state.js';

const T0 = new Date('2026-11-08T06:50:00Z').getTime();
const MIN = 60 * 1000;

test('空队列：队头是 null，没有待办', () => {
  const state = defaultState();
  assert.equal(pendingHead(state, 'say'), null);
  assert.equal(pendingHead(state, 'ticket'), null);
  assert.equal(pendingCount(state, 'say'), 0);
  assert.equal(hasPendingItems(state), false);
  assert.equal(ackPending(state, 'say', 'p1'), 0, '空队列 ack 不炸');
});

test('只有一条：入队就能取到，ack 之后真空', () => {
  const state = defaultState();
  const added = enqueuePending(state, 'say', { text: '备份该清了', at: T0 });
  assert.equal(added.added, true);
  assert.equal(added.dropped, 0);
  assert.equal(pendingHead(state, 'say').text, '备份该清了');
  assert.equal(hasPendingItems(state), true);

  assert.equal(ackPending(state, 'say', added.id), 1, '出队要确认');
  assert.equal(pendingHead(state, 'say'), null);
  assert.equal(hasPendingItems(state), false);
  assert.equal(ackPending(state, 'say', added.id), 0, '重复 ack 是空操作');
});

test('连续追加三条：按产生时间排队，逐条取出，不互相覆盖', () => {
  const state = defaultState();
  const ids = [
    enqueuePending(state, 'say', { text: '第一句', at: T0 }, {}).id,
    enqueuePending(state, 'say', { text: '第二句', at: T0 + MIN }, {}).id,
    enqueuePending(state, 'say', { text: '第三句', at: T0 + 2 * MIN }, {}).id,
  ];
  assert.equal(pendingCount(state, 'say'), 3, '三条都在，谁也别盖谁');

  assert.equal(pendingHead(state, 'say').text, '第一句');
  ackPending(state, 'say', ids[0]);
  assert.equal(pendingHead(state, 'say').text, '第二句');
  assert.equal(pendingCount(state, 'say'), 2, '没确认的那两条还在');
  ackPending(state, 'say', ids[1]);
  assert.equal(pendingHead(state, 'say').text, '第三句');
  ackPending(state, 'say', ids[2]);
  assert.equal(pendingCount(state, 'say'), 0);
});

test('乱序到达也按 at 排序：后入队的旧条目排到前面', () => {
  const state = defaultState();
  enqueuePending(state, 'say', { text: '晚的', at: T0 + 5 * MIN });
  enqueuePending(state, 'say', { text: '早的', at: T0 });
  assert.deepEqual(
    state.pendingSayQueue.map((entry) => entry.text),
    ['早的', '晚的'],
  );
});

test('同一内容重复入队：合并成一条，at 不刷新（原 rememberSay 语义）', () => {
  const state = defaultState();
  enqueuePending(state, 'say', { text: '同一句', at: T0 });
  const again = enqueuePending(state, 'say', { text: '同一句', at: T0 + 10 * MIN });
  assert.equal(again.added, false);
  assert.equal(again.duplicate, true);
  assert.equal(pendingCount(state, 'say'), 1);
  assert.equal(pendingHead(state, 'say').at, T0, '不刷新 at，TTL 才不会被重复入队续命');
});

test('同一张票重复入队：按 callId 合并；内容查找拿得到原 callId', () => {
  const state = defaultState();
  const callId = 'proactive-2026-11-08-1';
  enqueuePending(state, 'ticket', { goal: '补 TODO', brief: '补 TODO', callId, at: T0 });
  const again = enqueuePending(state, 'ticket', { goal: '补 TODO', brief: '补 TODO', callId, at: T0 + MIN });
  assert.equal(again.added, false);
  assert.equal(pendingCount(state, 'ticket'), 1);
  assert.equal(findPendingTicketByContent(state, { goal: '补 TODO', brief: '补 TODO' })?.callId, callId);
  assert.equal(findPendingTicketByContent(state, { goal: '别的事', brief: '别的事' }), null);
});

test('不同内容的票各排各的：不覆盖，逐张开出', () => {
  const state = defaultState();
  enqueuePending(state, 'ticket', { goal: '甲', brief: '甲', callId: 'proactive-2026-11-08-1', at: T0 });
  enqueuePending(state, 'ticket', { goal: '乙', brief: '乙', callId: 'proactive-2026-11-08-2', at: T0 + MIN });
  assert.equal(pendingCount(state, 'ticket'), 2);
  ackPendingByKey(state, 'ticket', { callId: 'proactive-2026-11-08-1' });
  assert.equal(pendingHead(state, 'ticket').goal, '乙');
});

test(`满上限 ${PENDING_LIMIT} 条：再进来一条就丢最旧的，日志带丢了几条`, () => {
  const state = defaultState();
  const logs = [];
  for (let index = 0; index < PENDING_LIMIT; index += 1) {
    enqueuePending(state, 'say', { text: `第 ${index} 句`, at: T0 + index * 1000 }, { log: (line) => logs.push(line) });
  }
  assert.equal(pendingCount(state, 'say'), PENDING_LIMIT);
  assert.deepEqual(logs, [], '没超上限不许打日志');

  const overflow = enqueuePending(
    state,
    'say',
    { text: `第 ${PENDING_LIMIT} 句`, at: T0 + PENDING_LIMIT * 1000 },
    { log: (line) => logs.push(line) },
  );
  assert.equal(overflow.dropped, 1);
  assert.equal(pendingCount(state, 'say'), PENDING_LIMIT, '长度封在 50');
  assert.equal(pendingHead(state, 'say').text, '第 1 句', '丢的是最旧那条');
  assert.ok(logs.some((line) => line.includes('上限 50') && line.includes('1 条')), `日志要带条数，实际：${logs.join(' | ')}`);

  // 一次进太多：丢几条要如实报
  const bulk = [];
  for (let index = 0; index < 5; index += 1) {
    bulk.push(
      enqueuePending(state, 'say', { text: `批量 ${index}`, at: T0 + (PENDING_LIMIT + index) * 1000 }, { log: (line) => logs.push(line) }),
    );
  }
  assert.equal(bulk.at(-1).dropped, 1, '每进一条只超一条');
  assert.equal(pendingCount(state, 'say'), PENDING_LIMIT);
});

test('清过期：整条队列扫一遍，只摘过期的，顺序不变', () => {
  const state = defaultState();
  enqueuePending(state, 'say', { text: '老', at: T0 });
  enqueuePending(state, 'say', { text: '新', at: T0 + 10 * MIN });
  const dropped = pruneQueue(state, 'say', T0 + 31 * MIN, 30 * MIN, isExpired);
  assert.equal(dropped, 1);
  assert.deepEqual(
    state.pendingSayQueue.map((entry) => entry.text),
    ['新'],
  );
});

test('旧单槽迁移：搬进队列，旧字段清空；回滚写回旧字段也搬得动', () => {
  const state = defaultState();
  state.pendingSay = { text: '旧话', at: T0 };
  state.pendingTicket = { goal: '旧票', brief: '旧票', callId: 'proactive-2026-11-08-1', at: T0 };
  const logs = [];
  migrateLegacyPending(state, { log: (line) => logs.push(line) });
  assert.equal(pendingCount(state, 'say'), 1);
  assert.equal(pendingCount(state, 'ticket'), 1);
  assert.equal(pendingHead(state, 'say').text, '旧话');
  assert.equal(state.pendingSay, null);
  assert.equal(state.pendingTicket, null);
  assert.equal(logs.filter((line) => line.includes('搬进队列')).length, 2);
});

test('队列非空时旧单槽照样搬：同内容被去重，不同内容并进队尾', () => {
  const state = defaultState();
  enqueuePending(state, 'say', { text: '队列里本来就有', at: T0 });
  state.pendingSay = { text: '队列里本来就有', at: T0 };
  migrateLegacyPending(state);
  assert.equal(pendingCount(state, 'say'), 1, '同内容不许变两条');

  state.pendingSay = { text: '回滚期间又存的', at: T0 + MIN };
  migrateLegacyPending(state);
  assert.equal(pendingCount(state, 'say'), 2);
  assert.equal(pendingHead(state, 'say').text, '队列里本来就有', '老的排前面，新的排后面');
  assert.equal(state.pendingSay, null);
});

test('重启往返：队列和 id 序号都从 state 文件里读回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-pending-'));
  const file = path.join(dir, 'ego.state.json');
  const state = defaultState();
  enqueuePending(state, 'say', { text: '第一句', at: T0 });
  enqueuePending(state, 'say', { text: '第二句', at: T0 + MIN });
  writeState(file, state);

  const back = readState(file);
  assert.equal(pendingCount(back, 'say'), 2);
  assert.deepEqual(
    back.pendingSayQueue.map((entry) => entry.text),
    ['第一句', '第二句'],
  );
  const next = enqueuePending(back, 'say', { text: '第三句', at: T0 + 2 * MIN });
  assert.equal(next.id, 'p3', '重启后 id 接着数，不重号');
  fs.rmSync(dir, { recursive: true, force: true });
});
