/**
 * ask 文案规范单测：对象 / 数量 / 依据 / 一个问句 / 60~160 个字符 / 禁词 / 数字只能来自点子与理由。
 * 口径是字符数（含标点、路径、数字），不是汉字数——理由写在 lib/judge.js 的 ASK_MIN_CHARS 上头。
 * 这一支是用户唯一会看到的那句话，不合格宁可这一拍失败也不许发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_FORBIDDEN,
  ASK_LEN_NOTE,
  ASK_MAX_CHARS,
  ASK_MIN_CHARS,
  buildJudgePrompt,
  charLength,
  numbersIn,
  parseDecision,
  validateAskText,
} from '../lib/judge.js';

/** 这次的真实背景：example-db 的 jobs 表里 55 条 retry，队列共 337 条 */
const IDEA = 'example-db 的 jobs 表里 55 条 retry 记录该清掉';
const WHY = '原文已不存在，重放只会再标一次 done，却每轮占一个重放名额，当前队列 337 条';

/** 票里给的正例，必须一字不差地过 */
export const GOOD_TEXT =
  'example-db 的 jobs 表里有 55 条 retry 记录，它们引用的原文早就没了，' +
  '重放只会再标一次 done，却每轮占一个名额——当前队列 337 条。' +
  '清掉这批吗？清掉不可恢复，不清就继续占名额。';

/** 这次发到用户那边的反例：用户看不懂 */
export const BAD_TEXT = '嗯，55 条死账删了捞不回来，assistant 不敢自己下刀，用户点头 assistant 再动。';

test('正例：对象、数量、依据、一个问句、长度都合规', () => {
  const result = validateAskText(GOOD_TEXT, { idea: IDEA, why: WHY });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(charLength(GOOD_TEXT), 105);
  assert.ok(charLength(GOOD_TEXT) >= ASK_MIN_CHARS && charLength(GOOD_TEXT) <= ASK_MAX_CHARS);
  assert.deepEqual(numbersIn(GOOD_TEXT), ['55', '337']);
});

test('正例能通过裁决器解析，并原样带出文案', () => {
  const decision = parseDecision(
    JSON.stringify({ action: 'ask', text: GOOD_TEXT, reason: '删了不可恢复，只能问' }),
    { idea: IDEA, why: WHY },
  );
  assert.equal(decision.action, 'ask');
  assert.equal(decision.text, GOOD_TEXT);
});

test('黑话和内部术语命中就判死：死账 / 下刀 / 捞不回来 / 开刀 / 动刀 / 按照规则 2 / 您', () => {
  assert.equal(validateAskText(BAD_TEXT, { idea: IDEA, why: WHY }).ok, false);
  for (const word of ASK_FORBIDDEN) {
    const text = GOOD_TEXT.replace('清掉这批吗', `${word}清掉这批吗`);
    const result = validateAskText(text, { idea: IDEA, why: WHY });
    assert.equal(result.ok, false, `「${word}」不该放过去`);
    assert.ok(
      result.problems.some((p) => p.includes(word)),
      `问题里要说清命中了「${word}」：${result.problems.join('；')}`,
    );
  }
});

test('缺数量、缺问句、多个问句都不发', () => {
  const noNumber = GOOD_TEXT.replace('55 条', '一些').replace('337 条', '一批');
  const noNumberResult = validateAskText(noNumber, { idea: IDEA, why: WHY });
  assert.equal(noNumberResult.ok, false);
  assert.ok(noNumberResult.problems.some((p) => p.includes('没写数量')));

  const noQuestion = GOOD_TEXT.replace('清掉这批吗？', '清掉这批。');
  const noQuestionResult = validateAskText(noQuestion, { idea: IDEA, why: WHY });
  assert.equal(noQuestionResult.ok, false);
  assert.ok(noQuestionResult.problems.some((p) => p.includes('没有明确问句')));

  const twoQuestions = GOOD_TEXT.replace('清掉这批吗？', '清掉这批吗？还是留着？');
  const twoResult = validateAskText(twoQuestions, { idea: IDEA, why: WHY });
  assert.equal(twoResult.ok, false);
  assert.ok(twoResult.problems.some((p) => p.includes('只能留一个')));
});

test('长度卡在 60~160 个字符：太短、太长都报错', () => {
  const tooShort = '要不要清掉 jobs 表里那 55 条记录？清掉就没了。';
  const shortResult = validateAskText(tooShort, { idea: IDEA, why: WHY });
  assert.equal(shortResult.ok, false);
  assert.ok(shortResult.problems.some((p) => p.includes(`不到 ${ASK_MIN_CHARS} 个字符`)));

  const tooLong = `${GOOD_TEXT}再补一句解释，说明这批记录是怎么来的、当初为什么会留下、以及以后怎么避免同样的事再占一轮重放名额，免得用户还得再问一遍。`;
  assert.ok(charLength(tooLong) > ASK_MAX_CHARS);
  const longResult = validateAskText(tooLong, { idea: IDEA, why: WHY });
  assert.equal(longResult.ok, false);
  assert.ok(longResult.problems.some((p) => p.includes(`超过 ${ASK_MAX_CHARS} 个字符`)));
});

test('数字只能来自点子和理由：自己编一个 999 就被拦下', () => {
  const invented = GOOD_TEXT.replace('337 条', '999 条');
  const result = validateAskText(invented, { idea: IDEA, why: WHY });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('999')), result.problems.join('；'));
});

test('没写对象就拦：只有「一堆东西」不算说清', () => {
  const vague =
    '现在有 55 个东西需要处理，它们已经放在那里很久了，清掉之后能省出一些空间，也不会再占着位置。' +
    '清掉吗？清掉不可恢复，不清就继续占着。';
  assert.ok(charLength(vague) >= ASK_MIN_CHARS);
  const result = validateAskText(vague, { idea: IDEA, why: WHY });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('没写清对象')));
});

test('裁决器提示词写清三要素、正反例和禁词，并要求数字有出处', () => {
  const prompt = buildJudgePrompt({ idea: IDEA, why: WHY });
  assert.ok(prompt.includes('三样缺一不可'));
  assert.ok(prompt.includes('对象：具体是什么'));
  assert.ok(prompt.includes('为什么：一句话讲清'));
  assert.ok(prompt.includes('要用户定什么：一个明确问句'));
  assert.ok(prompt.includes(GOOD_TEXT), '正例要原样写进提示词');
  assert.ok(prompt.includes(BAD_TEXT), '反例要原样写进提示词');
  assert.ok(prompt.includes('死账') && prompt.includes('下刀') && prompt.includes('捞不回来'));
  assert.ok(prompt.includes(ASK_LEN_NOTE), '提示词要写清口径（字符数，不是汉字数）');
  assert.ok(prompt.includes('必须是**最后一句**'), '问句要收尾');
  assert.ok(prompt.includes('JSON 必须一次写完整、闭合'), '要求闭合的 JSON');
  assert.ok(prompt.includes('走到一半断掉') || prompt.includes('写到一半断掉'), '要带一个写到一半被截断的反例');
  assert.ok(prompt.includes('不许自己编'));
  assert.ok(prompt.includes('您'), '禁词表里要有「您」');
});
