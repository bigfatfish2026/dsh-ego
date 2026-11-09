/**
 * 策略项可配置：素材池、对象名词表、ask 长度与禁词。
 *
 * 这几项只改提示词内容和校验口径，不改流程，所以都在纯函数上测：
 * 传自定义值必须生效，不传必须退回内置默认（旧配置只写一部分也得能跑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDEA_OBJECT_HINTS,
  PROPOSER_MATERIALS,
  buildProposerPrompt,
  parseProposal,
  validateIdea,
} from '../lib/proposer.js';
import {
  ASK_FORBIDDEN,
  ASK_MAX_CHARS,
  ASK_MIN_CHARS,
  buildJudgePrompt,
  parseDecisionReport,
  validateAskText,
} from '../lib/judge.js';

const IDEA = 'example-db 的 jobs 表里 55 条 retry 记录该清掉';
const WHY = '原文已不存在，重放只会再标一次 done，当前队列 337 条';
const ASK =
  'example-db 的 jobs 表里 55 条 retry 记录已经没有原文了，' +
  '重放只会再标一次 done，却每轮占一个名额——当前队列 337 条。' +
  '清掉这批吗？清掉不可恢复，不清就继续占名额。';

test('素材池可换：配置给什么就往提示词里写什么，不再塞代码里的默认', () => {
  const custom = ['检查本地仓库有没有该推的提交'];
  const prompt = buildProposerPrompt({ now: new Date('2026-11-09T12:00:00Z'), state: {}, materials: custom });
  assert.ok(prompt.includes(custom[0]), '自定义素材要进提示词');
  assert.ok(prompt.includes('可以往这些方向想'), '有素材就带方向标题');
  assert.ok(prompt.includes(`  1. ${custom[0]}`), '编号段要接自定义素材');
});

test('素材池为空：不输出空标题和空编号段，提示词照样完整', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const bare = buildProposerPrompt({ now, state: {} });
  const empty = buildProposerPrompt({ now, state: {}, materials: [] });
  const blank = buildProposerPrompt({ now, state: {}, materials: ['', '   '] });
  for (const prompt of [bare, empty, blank]) {
    assert.equal(prompt.includes('可以往这些方向想'), false, '空素材不该列方向');
    assert.equal(/^\s+\d+\.\s*$/m.test(prompt), false, '不能留空编号行');
    assert.ok(prompt.includes('规矩'), '没素材也要有规矩段');
    assert.ok(prompt.includes('{"idea"'), '没素材也要有输出格式');
  }
  assert.equal(bare.includes('undefined'), false);
  assert.deepEqual(PROPOSER_MATERIALS, [], '代码里不再持有默认清单');
});

test('对象名词表可换：配了词表就按词表卡，空词表只卡数量', () => {
  assert.equal(validateIdea('有 3 个构建产物可以删', { objectHints: ['构建产物'] }).ok, true);
  const rejected = validateIdea('有 3 个构建产物可以删', { objectHints: ['表', '文件'] });
  assert.equal(rejected.ok, false, '词表里没有这个词就该判不具体');
  assert.ok(rejected.problems.some((p) => p.includes('对象')), rejected.problems.join('；'));
  assert.deepEqual(IDEA_OBJECT_HINTS, [], '代码里不再持有默认名词表');
  assert.equal(validateIdea('有 3 个构建产物可以删').ok, true, '空词表不该把所有点子判死');
  assert.equal(validateIdea('整理一下仓库').ok, false, '空词表下数量仍要卡');
});

test('对象名词表接进提议器解析：配了按配的判，空词表不判死', () => {
  const text = JSON.stringify({ idea: '有 3 个构建产物可以删', why: '编译完就没用了' });
  const custom = parseProposal(text, { objectHints: ['构建产物'] });
  assert.deepEqual(custom, { idea: '有 3 个构建产物可以删', why: '编译完就没用了' });
  assert.equal(parseProposal(text, { objectHints: ['表', '文件'] }), null, '词表里没有就整条丢掉');
  assert.deepEqual(parseProposal(text), custom, '空词表只看数量，不判死');
  assert.equal(parseProposal(JSON.stringify({ idea: '整理一下仓库', why: '看着乱' })), null, '没数量仍收不了');
});

test('ask 长度可配：上限收窄后，默认合格的文案会被拦', () => {
  assert.equal(validateAskText(ASK, { idea: IDEA, why: WHY }).ok, true);
  const strict = validateAskText(ASK, { idea: IDEA, why: WHY, rules: { maxChars: 40 } });
  assert.equal(strict.ok, false);
  assert.ok(strict.problems.some((p) => p.includes('超过 40 个字符')), strict.problems.join('；'));

  const loose = validateAskText(ASK, { idea: IDEA, why: WHY, rules: { minChars: 1, maxChars: 2000 } });
  assert.equal(loose.ok, true);
});

test('ask 上下限默认值不变，缺项时各自退回默认', () => {
  assert.equal(ASK_MIN_CHARS, 60);
  assert.equal(ASK_MAX_CHARS, 160);
  const onlyMax = validateAskText('太短了，删 55 条吗？', { idea: IDEA, why: WHY, rules: { maxChars: 160 } });
  assert.ok(onlyMax.problems.some((p) => p.includes('不到 60 个字符')), onlyMax.problems.join('；'));
});

test('禁词表可换：自定义词命中就拦，默认词表不再生效', () => {
  const text = ASK.replace('清掉这批吗', '把这些破玩意清掉吗');
  const custom = validateAskText(text, { idea: IDEA, why: WHY, rules: { forbidden: ['破玩意'] } });
  assert.equal(custom.ok, false);
  assert.ok(custom.problems.some((p) => p.includes('破玩意')), custom.problems.join('；'));

  const withDefault = validateAskText(text, { idea: IDEA, why: WHY });
  assert.equal(withDefault.ok, true, '默认禁词表里没有「破玩意」');
  assert.ok(ASK_FORBIDDEN.includes('您'));
});

test('禁词和长度接进裁决器提示词与解析：自定义口径前后一致', () => {
  const prompt = buildJudgePrompt({ idea: IDEA, why: WHY, rules: { minChars: 30, maxChars: 200, forbidden: ['破玩意'] } });
  assert.ok(prompt.includes('30~200 个字符'), '提示词要写自定义长度');
  assert.ok(prompt.includes('破玩意'), '提示词要列出自定义禁词');
  assert.ok(prompt.includes('不许用'), '仍要明确写清禁词规矩');

  const reply = JSON.stringify({ action: 'ask', text: ASK, reason: '删了不可恢复' });
  const strict = parseDecisionReport(reply, { idea: IDEA, why: WHY, rules: { maxChars: 40 } });
  assert.equal(strict.ok, false);
  assert.equal(strict.scope, 'ask');
  const loose = parseDecisionReport(reply, { idea: IDEA, why: WHY });
  assert.equal(loose.ok, true, loose.problems?.join('；'));
});
