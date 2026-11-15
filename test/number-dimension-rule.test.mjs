/**
 * 提示词里的「数字带量纲」那一条。
 *
 * GA10 按量纲核数字（lib/gate.js 的 ideaNumbersIn）：数字带量纲、带小数、是行号，
 * 就要在 evidence[].value 里有字面出处。所以「0.1%」这种写法模型得自己补 evidence，
 * 「0.1 的可能」这种没量纲的说法只能靠改写法避开——两版提示词都得把这条说清楚，
 * 而且必须是同一句话（一处定义、两处引用），别一处说「量纲」一处说「单位」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NUMBER_DIMENSION_RULE,
  buildStage2Prompt,
  buildStage2RewritePrompt,
} from '../lib/proposer.js';

test('常量本身：一句话，说清带量纲，给了量纲例子', () => {
  assert.equal(typeof NUMBER_DIMENSION_RULE, 'string');
  assert.match(NUMBER_DIMENSION_RULE, /带量纲/);
  assert.match(NUMBER_DIMENSION_RULE, /0\.1%/);
  assert.match(NUMBER_DIMENSION_RULE, /MB\/GB\/字节/);
  assert.match(NUMBER_DIMENSION_RULE, /秒\/毫秒/);
  assert.match(NUMBER_DIMENSION_RULE, /文件:行号/);
  assert.ok(NUMBER_DIMENSION_RULE.startsWith('· '), '跟硬要求段其它条目一个风格');
});

test('stage2 首写提示词带这一条', () => {
  const prompt = buildStage2Prompt([], [], {});
  assert.ok(prompt.includes('带量纲'), '首写提示词要出现「带量纲」');
  assert.ok(prompt.includes(NUMBER_DIMENSION_RULE), '原句整条要进首写提示词');
});

test('stage2 重写提示词带同一句', () => {
  const message = buildStage2RewritePrompt({});
  assert.ok(message.includes('带量纲'), '重写提示词要出现「带量纲」');
  assert.ok(message.includes(NUMBER_DIMENSION_RULE), '原句整条要进重写提示词');
});

test('两处措辞一致：同一字符串常量，各只出现一次', () => {
  const first = buildStage2Prompt([], [], {});
  const rewrite = buildStage2RewritePrompt({});
  assert.equal(first.split(NUMBER_DIMENSION_RULE).length - 1, 1, '首写提示词里只有一条');
  assert.equal(rewrite.split(NUMBER_DIMENSION_RULE).length - 1, 1, '重写提示词里只有一条');
  // 措辞不许分叉：两处都只有「量纲」，没有另写一套「单位」的说法
  assert.equal(rewrite.includes('单位'), false);
});

test('重写提示词里原有一句保留不动', () => {
  const message = buildStage2RewritePrompt({});
  assert.ok(message.includes('idea 里每个数字都能在 evidence[].value 里找到字面相同的值'));
});
