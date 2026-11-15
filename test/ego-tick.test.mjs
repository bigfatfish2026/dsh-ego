/**
 * ego_tick 工具：主会话不用 touch 文件，直接催一拍。
 *
 * 盯这些：
 *   1. 空参调用真的跑一拍，摘要里有落点 / verdict / 耗时；
 *   2. reason 进日志行（固定格式）；
 *   3. 上一拍在跑时直接跳过，不排队、不并发；
 *   4. dryRun=true/false 只在这一拍覆盖配置；
 *   5. 额外补跑不动 nextRunAt / failStreak / retryAfterAt；
 *   6. 源码断言：ego_tick 不在提议器/终审的 allow 列表里，touch 老路还在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EGO_TICK_DESCRIPTION,
  classifyTickOutcome,
  createEgoTickTool,
  createManualTick,
  formatTickLog,
  formatTickSummary,
  normalizeTickReason,
} from '../lib/ego-tick.js';
import { createTicketOpener } from '../lib/route.js';
import { defaultState } from '../lib/state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SOURCE = [
  fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8'),
  fs.readFileSync(path.join(HERE, '..', 'lib', 'engines', 'lifecycle.js'), 'utf8'),
  fs.readFileSync(path.join(HERE, '..', 'lib', 'config.js'), 'utf8'),
].join('\n');
const PATCH_SOURCE = fs.readFileSync(path.join(HERE, '..', 'cordis.patch.yml'), 'utf8');
const T0 = Date.parse('2026-11-11T12:00:00Z');

/** 一套手动催拍 fixture：互斥、dryRun 覆盖都跟 index.js 一样挂在外部变量上。 */
function fixture(over = {}) {
  const state = defaultState();
  state.nextRunAt = T0 + 47 * 60 * 1000;
  state.failStreak = 2;
  let busy = false;
  let dry = null;
  const lines = [];
  const calls = [];
  const cfg = {
    enabled: true,
    privateOnly: false,
    dryRun: false,
    maxFailStreak: 3,
    backoffMinutes: 60,
    ...(over.cfg ?? {}),
  };
  const manualTick = createManualTick({
    state,
    cfg,
    targetId: () => 'session-abc',
    scopeOf: () => 'c2c',
    isBusy: () => busy,
    setBusy: (value) => {
      busy = value;
    },
    runRound: over.runRound ?? (async (nowMs) => {
      calls.push(nowMs);
      return { ok: true, action: 'silent', verdict: 'silent', rewrites: 0 };
    }),
    save: () => {},
    log: (line) => lines.push(line),
    getDryRunOverride: () => dry,
    setDryRunOverride: (value) => {
      dry = value;
    },
  });
  return {
    state,
    cfg,
    manualTick,
    lines,
    calls,
    isBusy: () => busy,
    dryOverride: () => dry,
  };
}

/** 假时钟：跑一拍时把时间往前推 ms。 */
function clock(stepMs = 0) {
  let t = T0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    stepMs,
  };
}

/* ── 1. 空参调用：跑一拍，摘要含落点 / verdict / 耗时 ─────────── */

test('空参调用跑一拍：摘要含落点、judge verdict、耗时秒数', async () => {
  const fx = fixture();
  const c = clock();
  const tool = createEgoTickTool({
    manualTick: async (nowMs, options) => {
      c.advance(1830);
      return fx.manualTick(nowMs, options);
    },
    log: (line) => fx.lines.push(line),
    now: c.now,
    isBusy: fx.isBusy,
  });
  const text = await tool({});
  assert.deepEqual(fx.calls, [T0], '空参也要真跑一拍');
  assert.match(text, /落点 silent/, '摘要要有落点');
  assert.match(text, /judge verdict silent/, '摘要要有 judge verdict');
  assert.match(text, /耗时 1\.83s/, '摘要要有耗时秒数');
  assert.equal(fx.state.failStreak, 2, '额外补跑不清空 failStreak');
  assert.equal(fx.state.nextRunAt, T0 + 47 * 60 * 1000, '额外补跑不改 nextRunAt');
});

/* ── 2. reason 进日志行 ───────────────────────────────────────── */

test('reason 进日志：固定格式、压成单行、超长截断', async () => {
  const fx = fixture();
  const c = clock();
  let logged = '';
  const tool = createEgoTickTool({
    manualTick: async (nowMs, options) => {
      c.advance(12);
      return fx.manualTick(nowMs, options);
    },
    log: (line) => {
      logged = line;
    },
    now: c.now,
    isBusy: fx.isBusy,
  });
  await tool({ reason: '改完验收' });
  assert.equal(logged, 'ego_tick:手动催拍｜reason:改完验收｜结果:silent｜12ms');

  await tool({ reason: '第一行\n第二行' });
  assert.equal(logged, 'ego_tick:手动催拍｜reason:第一行 第二行｜结果:silent｜12ms', '换行要压成空格');

  await tool({ reason: 'x'.repeat(200) });
  assert.equal(logged, `ego_tick:手动催拍｜reason:${'x'.repeat(120)}｜结果:silent｜12ms`, 'reason 截到 120 字');
  assert.equal(logged.split('\n').length, 1, '日志必须单行');

  assert.equal(normalizeTickReason('  '), '未写');
  assert.match(formatTickLog({ reason: '', outcome: 'ask', ms: 0.4 }), /reason:未写｜结果:ask｜0ms$/);
});

/* ── 3. 并发保护：上一拍在跑就跳过，不排队 ─────────────────────── */

test('上一拍在跑时再调：返回跳过，不并发跑第二拍', async () => {
  const fx = fixture();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = fixture({
    runRound: async (nowMs) => {
      slow.calls.push(nowMs);
      await gate;
      return { ok: true, action: 'ask', verdict: 'ask', rewrites: 0 };
    },
  });
  const first = slow.manualTick(T0);
  const second = await slow.manualTick(T0);
  assert.equal(first instanceof Promise, true);
  assert.equal(second.ok, false);
  assert.equal(second.busy, true, '要标成「上一拍还在跑」');
  assert.match(second.error, /上一拍还在跑/);
  assert.equal(slow.calls.length, 1, '第二拍不许真跑');
  release();
  await first;
  assert.equal(slow.isBusy(), false, '跑完把锁放开');
});

test('工具层并发：isBusy 时直接返回跳过，不叫 manualTick', async () => {
  let called = 0;
  let logged = '';
  const tool = createEgoTickTool({
    manualTick: async () => {
      called += 1;
      return { ok: true, action: 'do' };
    },
    log: (line) => {
      logged = line;
    },
    now: () => T0,
    isBusy: () => true,
  });
  const text = await tool({ reason: '并发试一下' });
  assert.equal(called, 0, '忙的时候一拍都不许跑');
  assert.match(text, /落点 跳过/);
  assert.match(text, /上一拍还在跑，跳过/);
  assert.equal(logged, 'ego_tick:手动催拍｜reason:并发试一下｜结果:跳过｜0ms');
});

/* ── 4. dryRun 覆盖配置：只在这一次调用生效 ───────────────────── */

test('dryRun=true 覆盖配置：这一拍走演练，跑完恢复配置', async () => {
  let seen = null;
  const fx = fixture({
    runRound: async () => ({ ok: true, action: 'ask', verdict: 'ask', rewrites: 0 }),
  });
  // runRound 跑完后再读：manualTick 的 finally 已经把 override 恢复
  const text = await (async () => {
    const tool = createEgoTickTool({
      manualTick: async (nowMs, options) => {
        const result = await fx.manualTick(nowMs, options);
        seen = fx.dryOverride();
        return result;
      },
      log: () => {},
      now: () => T0,
      isBusy: fx.isBusy,
    });
    return tool({ dryRun: true });
  })();
  assert.equal(seen, null, '跑完要把 override 恢复成 null');
  assert.equal(fx.cfg.dryRun, false, '配置本身不动');
  assert.match(text, /演练（不发消息不开票）/, '摘要要标演练');
  assert.equal(fx.state.failStreak, 2);
});

test('dryRun=true/false 在跑拍期间真的覆盖到读配置的地方', async () => {
  let during = null;
  const fx = fixture({
    runRound: async () => {
      during = fx.dryOverride();
      return { ok: true, action: 'silent', verdict: 'silent', rewrites: 0 };
    },
  });
  await fx.manualTick(T0, { dryRun: true });
  assert.equal(during, true, 'true 要覆盖');
  await fx.manualTick(T0, { dryRun: false });
  assert.equal(during, false, 'false 也要覆盖配置（配置是 true 时）');
  await fx.manualTick(T0);
  assert.equal(during, null, '不传就沿用配置（override 为 null）');
});

test('开票申请读函数式 dryRun：演练时不 followup', async () => {
  const state = defaultState();
  const lines = [];
  const sent = [];
  let dry = true;
  const opener = createTicketOpener({
    findAgent: () => ({ status: 'idle' }),
    targetId: () => 'session-abc',
    state,
    save: () => {},
    log: (line) => lines.push(line),
    dryRun: () => dry,
  });
  const ticket = { goal: '修一下日志轮转', brief: '日志太大了' };
  const dryRunFirst = await opener(ticket, T0);
  assert.equal(dryRunFirst.dry, true);
  assert.equal(sent.length, 0);
  dry = false;
  const forReal = await opener(ticket, T0);
  assert.equal(sent.length, 0, '假 agent 没 followup 方法也不该走到真发那一步');
  assert.equal(forReal.ok, false, '真跑那一次没发出去');
  assert.match(forReal.detail, /followup 失败/);
  assert.ok(lines.some((line) => line.includes('[dry]')), '演练要留 [dry] 日志');
  assert.equal(state.failStreak, 0);
});

/* ── 5. 不改 nextRunAt / failStreak，失败也不改 ───────────────── */

test('调用不改 nextRunAt：成功、失败两路都保持原排期和连败数', async () => {
  const okFx = fixture();
  const okBefore = okFx.state.nextRunAt;
  await okFx.manualTick(T0, { dryRun: true, account: false });
  assert.equal(okFx.state.nextRunAt, okBefore);
  assert.equal(okFx.state.failStreak, 2, '成功不清零');
  assert.equal(okFx.state.retryAfterAt, 0);

  const badFx = fixture({
    runRound: async () => ({ ok: false, error: '模型超时' }),
  });
  const badBefore = badFx.state.nextRunAt;
  const result = await badFx.manualTick(T0, { account: false });
  assert.equal(result.ok, false);
  assert.equal(badFx.state.nextRunAt, badBefore, '失败也不动排期');
  assert.equal(badFx.state.failStreak, 2, '失败不涨连败');
  assert.equal(badFx.state.retryAfterAt, 0, '失败不推退避');
  assert.equal(badFx.state.lastRunAt, T0, 'lastRunAt 记这一拍真跑了');
});

test('runRound 里偷偷改 nextRunAt 也会被改回去', async () => {
  const fx = fixture({
    runRound: async () => {
      fx.state.nextRunAt = T0;
      return { ok: true, action: 'silent', verdict: 'silent', rewrites: 0 };
    },
  });
  const before = fx.state.nextRunAt;
  await fx.manualTick(T0, { account: false });
  assert.equal(fx.state.nextRunAt, before);
  assert.ok(fx.lines.some((line) => line.includes('nextRunAt 被改动了')), '改回去要留日志');
});

/* ── 6. 摘要/落点：veto、rewrite、失败 ────────────────────────── */

test('落点归类与摘要：veto / rewrite→do / 失败原因', async () => {
  assert.equal(classifyTickOutcome({ ok: true, action: 'silent', vetoRejected: true }), 'veto');
  assert.equal(classifyTickOutcome({ ok: true, action: 'do', rewrites: 1 }), 'rewrite→do');
  assert.equal(classifyTickOutcome({ ok: false, error: 'x' }), '失败');
  assert.equal(classifyTickOutcome(null, { busy: true }), '跳过');

  const vetoText = formatTickSummary({ outcome: 'veto', verdict: null, ms: 420 });
  assert.match(vetoText, /落点 veto｜judge verdict 无｜耗时 0\.42s/);

  const failText = formatTickSummary({ outcome: '失败', verdict: null, ms: 30_000, error: '模型超时' });
  assert.match(failText, /落点 失败/);
  assert.match(failText, /失败原因：模型超时/);
});

test('工具遇到 runRound 抛错：摘要写失败原因，不把异常漏给主会话', async () => {
  const fx = fixture({
    runRound: async () => {
      throw new Error('create 抛错');
    },
  });
  const tool = createEgoTickTool({
    manualTick: fx.manualTick,
    log: () => {},
    now: () => T0,
    isBusy: fx.isBusy,
  });
  const text = await tool({ reason: '验异常' });
  assert.match(text, /落点 失败/);
  assert.match(text, /失败原因：create 抛错/);
});

/* ── 7. 源码断言：描述、allow 列表、touch 老路 ────────────────── */

test('工具描述一眼看懂：立刻跑一拍、跳过随机数与排期、验效果用', () => {
  assert.match(EGO_TICK_DESCRIPTION, /立刻跑一拍/);
  assert.match(EGO_TICK_DESCRIPTION, /跳过随机数与排期/);
  assert.match(EGO_TICK_DESCRIPTION, /改完代码验效果用/);
  assert.match(EGO_TICK_DESCRIPTION, /不是查询状态/);
});

test('ego_tick 不在提议器/终审的 allow 列表里', () => {
  const proposerBlock = INDEX_SOURCE.match(/const DEFAULT_PROPOSER_ALLOW = \[([\s\S]*?)\];/);
  const judgeBlock = INDEX_SOURCE.match(/const DEFAULT_JUDGE_ALLOW = \[([\s\S]*?)\];/);
  assert.ok(proposerBlock, '找不到 DEFAULT_PROPOSER_ALLOW');
  assert.ok(judgeBlock, '找不到 DEFAULT_JUDGE_ALLOW');
  assert.ok(!proposerBlock[1].includes('ego_tick'), '提议器不许自己催拍');
  assert.ok(!judgeBlock[1].includes('ego_tick'), '终审不许自己催拍');
  assert.ok(!PATCH_SOURCE.includes('ego_tick'), '实例配置的 allow 块也不许出现 ego_tick');
});

test('接线源码：ego_tick 注册一次、touch 老路还在', () => {
  assert.ok(INDEX_SOURCE.includes("name: 'ego_tick'"), '工具要注册');
  assert.equal((INDEX_SOURCE.match(/name: 'ego_tick'/g) ?? []).length, 1);
  assert.ok(INDEX_SOURCE.includes('createEgoTickTool'), '工具执行体从 ego-tick.js 来');
  assert.ok(INDEX_SOURCE.includes('createForceWatcher'), 'touch force 的老路不许删');
  assert.ok(INDEX_SOURCE.includes('forceTriggerPath'), '触发文件路径还在');
});
