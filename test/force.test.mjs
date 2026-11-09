/**
 * 手动催一拍（调试开关）的单测：
 *   · 触发文件存在就跑、跑完把文件删掉；
 *   · 轮询 dispose 之后不再触发；
 *   · 跳过骰子，但 privateOnly / 目标会话 / 互斥照旧；
 *   · nextRunAt 不被 debug 拍改掉；
 *   · failStreak 跟正常拍一样：成功清零、失败 +1。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkForceGate,
  createForceWatcher,
  runForcedRound,
} from '../lib/force.js';
import { defaultState } from '../lib/state.js';

const T0 = new Date('2026-11-08T09:10:00Z').getTime();

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-force-'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('触发文件在 → 跑一拍，同时文件被删掉', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'dsh-ego.force');
  fs.writeFileSync(file, '', 'utf8');
  let fired = 0;
  const watcher = createForceWatcher({
    filePath: file,
    intervalMs: 10,
    onForce: () => {
      fired += 1;
    },
  });
  assert.equal(watcher.check(), true, 'check() 看到文件就该返回 true');
  assert.equal(fired, 1, '文件存在要触发一次');
  assert.equal(fs.existsSync(file), false, '触发后文件必须删掉（否则每 15 秒重跑）');
  assert.equal(watcher.check(), false, '文件没了就不再触发');
  assert.equal(fired, 1);

  // 再来一次，走定时轮询那条路
  fs.writeFileSync(file, '', 'utf8');
  watcher.start();
  await sleep(60);
  watcher.stop();
  assert.equal(fired, 2, '轮询看到文件也要触发');
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dispose（stop）之后文件再出现也不触发', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'dsh-ego.force');
  let fired = 0;
  const watcher = createForceWatcher({ filePath: file, intervalMs: 10, onForce: () => { fired += 1; } });
  watcher.start();
  watcher.stop();
  fs.writeFileSync(file, '', 'utf8');
  await sleep(60);
  assert.equal(fired, 0, 'stop 之后一次都不该触发');
  assert.equal(watcher.stopped, true);
  assert.equal(watcher.check(), false, 'stop 之后手动 check 也不干活');
  assert.equal(fs.existsSync(file), true, 'stop 之后不该替用户删文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('删不掉文件时这轮不催（免得每 15 秒重跑同一拍）', () => {
  let fired = 0;
  const watcher = createForceWatcher({
    filePath: '/tmp/whatever.force',
    exists: () => true,
    remove: () => {
      throw new Error('EBUSY');
    },
    onForce: () => {
      fired += 1;
    },
  });
  assert.equal(watcher.check(), false);
  assert.equal(fired, 0);
});

test('privateOnly 保留：群聊拒、私聊放、配置写死的 targetSession 放', () => {
  const base = { enabled: true, busy: false, privateOnly: true, pinned: '', targetId: 'abc' };
  const group = checkForceGate({ ...base, scope: 'group' });
  assert.equal(group.ok, false, '私聊限制照样管着 debug 拍');
  assert.match(group.reason, /不是私聊/);
  assert.equal(checkForceGate({ ...base, scope: 'c2c' }).ok, true);
  assert.equal(checkForceGate({ ...base, scope: undefined }).ok, false, '认不出就不放');
  assert.equal(checkForceGate({ ...base, pinned: 'abc', scope: undefined }).ok, true, '配置写死的是用户显式指定');
  // privateOnly 关掉就不管目标是什么
  assert.equal(checkForceGate({ ...base, privateOnly: false, scope: 'group' }).ok, true);
});

test('目标会话必须有、上一拍没跑完就拒、插件关了也不催', () => {
  const base = { enabled: true, busy: false, privateOnly: false };
  assert.equal(checkForceGate({ ...base, targetId: '' }).ok, false, '没目标会话直接拒');
  assert.match(checkForceGate({ ...base, targetId: '' }).reason, /目标会话/);
  assert.equal(checkForceGate({ ...base, targetId: 'abc', busy: true }).ok, false, '正在跑就不排队');
  assert.equal(checkForceGate({ ...base, enabled: false, targetId: 'abc' }).ok, false);
});

test('跳过骰子：runForcedRound 不掷骰，日志写明 debug，nextRunAt 不动', async () => {
  const state = defaultState();
  state.nextRunAt = T0 + 47 * 60 * 1000;
  const lines = [];
  const calls = [];
  const result = await runForcedRound({
    nowMs: T0,
    state,
    cfg: { maxFailStreak: 3, backoffMinutes: 60 },
    log: (line) => lines.push(line),
    runRound: async (nowMs) => {
      calls.push(nowMs);
      return { ok: true, action: 'silent' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [T0], '立刻跑一拍');
  assert.ok(lines.some((l) => l.includes('[debug] 手动催拍，跳过掷骰')), '日志明确标出跳过掷骰');
  assert.ok(lines.some((l) => l.includes('debug 触发')), '日志说明这是 debug 触发，别看日志误判');
  assert.equal(state.nextRunAt, T0 + 47 * 60 * 1000, 'nextRunAt 必须保持原排期');
  assert.equal(state.lastRollAt, 0, '没掷骰就不该写 lastRollAt');
  assert.equal(state.lastRunAt, T0, 'lastRunAt 记成这一拍');
});

test('failStreak 跟正常拍一样：成功清零、失败 +1 并推 retryAfterAt', async () => {
  const okState = defaultState();
  okState.failStreak = 2;
  okState.retryAfterAt = T0 - 1000;
  await runForcedRound({
    nowMs: T0,
    state: okState,
    cfg: { maxFailStreak: 3, backoffMinutes: 60 },
    runRound: async () => ({ ok: true, action: 'ask' }),
  });
  assert.equal(okState.failStreak, 0, '成功清零');
  assert.equal(okState.retryAfterAt, 0, '惩罚解除');

  const badState = defaultState();
  badState.failStreak = 2;
  const result = await runForcedRound({
    nowMs: T0,
    state: badState,
    cfg: { maxFailStreak: 3, backoffMinutes: 60 },
    runRound: async () => ({ ok: false, error: '模型超时' }),
  });
  assert.equal(result.ok, false);
  assert.equal(badState.failStreak, 3, '失败 +1');
  assert.equal(badState.retryAfterAt, T0 + 60 * 60 * 1000, '到连败上限就照常推后');

  // runRound 自己抛错也要算一次失败，不能把状态弄丢
  const throwState = defaultState();
  const thrown = await runForcedRound({
    nowMs: T0,
    state: throwState,
    cfg: { maxFailStreak: 3, backoffMinutes: 60 },
    runRound: async () => {
      throw new Error('create 抛错');
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(throwState.failStreak, 1);
});
