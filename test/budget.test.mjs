/**
 * 三段输出预算。
 *
 * 背景：2026-11-11 12:21 那拍终审回 870 字符、JSON 没闭合，判 judgeFail；
 * 之前三段都写 0 = 不设上限，请求里干脆没有 max_tokens，截断发生在服务端默认预算。
 * 这一版给三段显式默认值，并且真把它们塞进宿主 agentOptions。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UNLIMITED_MAX_TOKENS, buildStage2Options, openAgentSession, routeOptions } from '../lib/agent-run.js';
import {
  JUDGE_MAX_TOKENS_DEFAULT,
  MAX_TOKENS_RANGES,
  STAGE1_MAX_TOKENS_DEFAULT,
  STAGE2_MAX_TOKENS_DEFAULT,
  clampJudgeMaxTokens,
  clampMaxTokens,
  clampStage1MaxTokens,
  clampStage2MaxTokens,
} from '../lib/budget.js';

test('默认值与区间：judge 4000（1000–8000）、stage2 8000（2000–16000）、stage1 2000（2000–16000）', () => {
  assert.deepEqual(
    { judge: JUDGE_MAX_TOKENS_DEFAULT, stage2: STAGE2_MAX_TOKENS_DEFAULT, stage1: STAGE1_MAX_TOKENS_DEFAULT },
    { judge: 4000, stage2: 8000, stage1: 2000 },
  );
  assert.deepEqual(
    { judge: [MAX_TOKENS_RANGES.judge.min, MAX_TOKENS_RANGES.judge.max],
      stage2: [MAX_TOKENS_RANGES.stage2.min, MAX_TOKENS_RANGES.stage2.max],
      stage1: [MAX_TOKENS_RANGES.stage1.min, MAX_TOKENS_RANGES.stage1.max] },
    { judge: [1000, 8000], stage2: [2000, 16000], stage1: [2000, 16000] },
  );
});

test('区间内的值原样透传，不再打 warn', () => {
  const warns = [];
  const warn = (line) => warns.push(line);
  assert.equal(clampJudgeMaxTokens(1000, { warn }), 1000);
  assert.equal(clampJudgeMaxTokens(4000, { warn }), 4000);
  assert.equal(clampJudgeMaxTokens(8000, { warn }), 8000);
  assert.equal(clampStage2MaxTokens(2000, { warn }), 2000);
  assert.equal(clampStage2MaxTokens(8000, { warn }), 8000);
  assert.equal(clampStage2MaxTokens(16000, { warn }), 16000);
  assert.equal(clampStage1MaxTokens(2000, { warn }), 2000);
  assert.deepEqual(warns, [], '区间内不该有 warn');
});

test('越界只夹边界 + warn：judge 999→1000 / 9000→8000；stage2 1500→2000 / 20000→16000', () => {
  const warns = [];
  const warn = (line) => warns.push(line);
  assert.equal(clampJudgeMaxTokens(999, { warn }), 1000);
  assert.equal(clampJudgeMaxTokens(9000, { warn }), 8000);
  assert.equal(clampStage2MaxTokens(1500, { warn }), 2000);
  assert.equal(clampStage2MaxTokens(20000, { warn }), 16000);
  assert.equal(clampStage1MaxTokens(1000, { warn }), 2000);
  assert.equal(clampStage1MaxTokens(99999, { warn }), 16000);
  assert.equal(warns.length, 6, `每条越界都要 warn，实际：${warns.join('｜')}`);
  assert.ok(warns.some((line) => line.includes('judge.maxTokens=9000 超过 8000')), warns.join('｜'));
});

test('0 / 缺省 / 非数字都按默认跑：0 是旧的「不限」，不再认', () => {
  const warns = [];
  const warn = (line) => warns.push(line);
  assert.equal(clampJudgeMaxTokens(0, { warn }), 4000);
  assert.equal(clampStage2MaxTokens(0, { warn }), 8000);
  assert.equal(clampStage1MaxTokens(0, { warn }), 2000);
  assert.equal(clampJudgeMaxTokens(undefined, { warn }), 4000);
  assert.equal(clampStage2MaxTokens(null, { warn }), 8000);
  assert.equal(clampJudgeMaxTokens('abc', { warn }), 4000);
  // 0 那条要留下日志，别的空值不必刷屏
  assert.equal(warns.filter((line) => line.includes('旧的「不限」写法')).length, 3, warns.join('｜'));
});

test('小数截整；字符串数字照收', () => {
  const warns = [];
  const warn = (line) => warns.push(line);
  assert.equal(clampJudgeMaxTokens(4000.7, { warn }), 4000);
  assert.equal(clampStage2MaxTokens('9000', { warn }), 9000);
  assert.ok(warns.some((line) => line.includes('不是整数，截成 4000')), warns.join('｜'));
  // 通用入口也能用：区间自己给
  assert.equal(clampMaxTokens(5, { name: 'x', def: 10, min: 10, max: 20 }, { warn }), 10);
});

test('默认值真的落进宿主 agentOptions：judge 走 routeOptions，stage2 走 buildStage2Options', () => {
  const judgeOptions = routeOptions({ provider: 'p', model: 'm', maxTokens: JUDGE_MAX_TOKENS_DEFAULT });
  assert.equal(judgeOptions.maxTokens, 4000, 'judge 4000 必须出现在 agentOptions 里');
  assert.deepEqual(judgeOptions, { provider: 'p', model: 'm', maxTokens: 4000 });
  const stage2Options = buildStage2Options({ provider: 'p', model: 'm', stage2MaxTokens: STAGE2_MAX_TOKENS_DEFAULT });
  assert.equal(stage2Options.maxTokens, 8000, 'stage2 8000 必须出现在 agentOptions 里');
  assert.deepEqual(stage2Options, { provider: 'p', model: 'm', maxTokens: 8000 });
  // stage2 只认 stage2MaxTokens，不看 proposer.maxTokens（stage1 的 2000 不许漏到 stage2）
  assert.equal('maxTokens' in buildStage2Options({ maxTokens: STAGE1_MAX_TOKENS_DEFAULT }), false);
});

test('openAgentSession 真把预算写进 create 的 agentOptions：judge 4000 / stage2 8000', async () => {
  const seen = [];
  const agent = {
    status: 'idle',
    session: { seq: 0, snapshotEvents: () => [] },
    followup() {},
    whenIdle() { return Promise.resolve(); },
  };
  const deps = {
    create: async (options) => {
      seen.push(options.agentOptions);
      return { agent, dispose: async () => {} };
    },
    log: () => {},
    uuid: () => 'fixed-uuid',
    now: () => 0,
  };

  const judgeSession = await openAgentSession(deps, {
    kind: 'judge',
    allow: ['read'],
    timeoutMs: 200,
    agentOptions: routeOptions({ provider: 'p', model: 'm', maxTokens: JUDGE_MAX_TOKENS_DEFAULT }),
  });
  assert.equal(judgeSession.ok, true);
  assert.deepEqual(seen[0], { provider: 'p', model: 'm', maxTokens: 4000 }, 'judge 会话 options 里要有 4000');
  await judgeSession.dispose();

  seen.length = 0;
  const stage2Session = await openAgentSession(deps, {
    kind: 'stage2',
    allow: ['read'],
    timeoutMs: 200,
    agentOptions: buildStage2Options({ stage2MaxTokens: STAGE2_MAX_TOKENS_DEFAULT }),
  });
  assert.equal(stage2Session.ok, true);
  assert.deepEqual(seen[0], { maxTokens: 8000 }, 'stage2 会话 options 里要有 8000');
  await stage2Session.dispose();
});

test('UNLIMITED_MAX_TOKENS 只剩 routeOptions 的「不传」语义，不再是默认配置', () => {
  assert.equal(UNLIMITED_MAX_TOKENS, 0);
  // 0 传进 routeOptions 仍然被剔掉（老语义不变），但 index 的默认值不再用它
  assert.equal('maxTokens' in routeOptions({ maxTokens: UNLIMITED_MAX_TOKENS }), false);
});
