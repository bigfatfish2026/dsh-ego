/**
 * 截断口径单测：这一支管「日志/诊断怎么显示」，也管「校验吃的是不是完整文本」。
 *
 * 一次真实事故的教训：
 *   · 日志里 JSON 断在 160 个字符（「…清掉吗？只删」）；
 *   · session 里那条裁决回复是完整闭合的 233 字符，JSON 一点没缺；
 *   · 被拦的真实原因是 ask 文案 127 字符 > 当时 120 的上限。
 * 所以单测必须钉住三件事：日志不丢内容、超长带明确标记、校验吃完整文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOG_TEXT_MAX, clipLogText, clipText } from '../lib/text.js';
import { ASK_MAX_CHARS, ASK_MIN_CHARS, charLength, parseDecision, parseDecisionReport, validateAskText } from '../lib/judge.js';

/** 那次的模型回复（取自 session，233 字符，JSON 完整闭合） */
const REAL_REPLY = '{"action": "ask", "text": "data/tmp/export_draft 里有 144 个导出中间产物：几版试稿里除定稿外的那些、临时对照图。11-04 11:09 定稿写回插件后就没再读过，它们占了 data/tmp 全部 467 个文件的三成。清掉吗？只删文件不动插件，删了不可恢复。", "ticket": {"goal": "", "brief": ""}, "reason": "删文件不可恢复，按规矩只能交用户点头，不能自己开票。"}';

/** 那次问的 ask 文案本体：129 字符 / 65 汉字，旧上限 120 时被拦，现在必须过 */
const REAL_ASK_TEXT = 'data/tmp/export_draft 里有 144 个导出中间产物：几版试稿里除定稿外的那些、临时对照图。11-04 11:09 定稿写回插件后就没再读过，它们占了 data/tmp 全部 467 个文件的三成。清掉吗？只删文件不动插件，删了不可恢复。';

const EVIDENCE = {
  idea: 'data/tmp/export_draft 里 144 个中间产物该清掉',
  why: '11-04 11:09 定稿后没再读过，占 data/tmp 全部 467 个文件的三成',
};

test('日志不截断：正常长度的原文一个字符都不丢', () => {
  const line = `裁决器的回复不能当裁决｜${REAL_REPLY}`;
  const out = clipLogText(line);
  assert.equal(out, line);
  assert.ok(out.includes(REAL_REPLY.slice(-30)), '尾巴必须还在');
  assert.ok(out.includes('清掉吗？只删文件不动插件'), '中段不许被切');
});

test('日志超长才截，且末尾写明「日志截断，原文 N 字符」', () => {
  const long = '甲'.repeat(LOG_TEXT_MAX + 500);
  const out = clipLogText(long);
  assert.ok(out.length < long.length, '超长要截');
  assert.ok(out.includes(`[日志截断，原文 ${charLength(long)} 字符]`), '必须标出原文长度');
  assert.equal(charLength(out.split('…[日志截断')[0]), LOG_TEXT_MAX, '保留的就是上限那么多');

  // 没超上限一个字也不许截
  const exact = '乙'.repeat(LOG_TEXT_MAX);
  assert.equal(clipLogText(exact), exact);
});

test('日志换行折成空格，不把一条日志拆成多行', () => {
  const out = clipLogText('第一行\n第二行\r\n第三行');
  assert.equal(out.includes('\n'), false);
  assert.ok(out.includes('第一行') && out.includes('第三行'));
});

test('诊断贴前 200 + 后 100，中间省略多少字写清楚', () => {
  const text = '头'.repeat(200) + '中'.repeat(50) + '尾'.repeat(100);
  const out = clipText(text);
  assert.ok(out.startsWith(`原文 ${charLength(text)} 字符：`), '先报原始长度');
  assert.ok(out.includes('头'.repeat(200)));
  assert.ok(out.includes('尾'.repeat(100)));
  assert.ok(out.includes('…[省略 50 字符]…'), '省略了多少要能数出来');
  assert.equal(out.includes('中'), false, '中间那段不贴');

  // 短文本原样，只加长度前缀
  assert.equal(clipText('短文案'), '原文 3 字符：短文案');
});

test('字数口径是字符数：129 字符 / 65 汉字的那条现在合格', () => {
  assert.equal(charLength(REAL_ASK_TEXT), 129);
  const han = [...REAL_ASK_TEXT].filter((c) => /\p{Script=Han}/u.test(c)).length;
  assert.ok(han < ASK_MIN_CHARS + 20, `汉字只有 ${han} 个，按汉字数看也不算短`);
  const result = validateAskText(REAL_ASK_TEXT, EVIDENCE);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.len, 129);
});

test('口径边界：160 字符过、161 字符不过，差的只是字符不是汉字', () => {
  assert.equal(ASK_MIN_CHARS, 60);
  assert.equal(ASK_MAX_CHARS, 160);
  const base = 'data/tmp/export_draft 里 144 个中间产物，11-04 11:09 后没再读过。清掉吗？';
  assert.ok(charLength(base) < ASK_MAX_CHARS);

  const padTo = (n) => base.replace('清掉吗？', `${'啊'.repeat(n - charLength(base))}清掉吗？`);
  const atMax = padTo(ASK_MAX_CHARS);
  assert.equal(charLength(atMax), ASK_MAX_CHARS);
  assert.equal(validateAskText(atMax, EVIDENCE).ok, true, `${ASK_MAX_CHARS} 字符该过`);

  const overMax = padTo(ASK_MAX_CHARS + 1);
  assert.equal(charLength(overMax), ASK_MAX_CHARS + 1);
  const overResult = validateAskText(overMax, EVIDENCE);
  assert.equal(overResult.ok, false);
  assert.ok(overResult.problems.some((p) => p.includes(`超过 ${ASK_MAX_CHARS} 个字符`)));

  // 下限同样按字符：59 字符被拦，60 字符放行
  const short = 'jobs 表里 55 条 retry 记录留着占名额，清掉吗？';
  assert.ok(charLength(short) < ASK_MIN_CHARS);
  assert.ok(validateAskText(short, EVIDENCE).problems.some((p) => p.includes(`不到 ${ASK_MIN_CHARS} 个字符`)));
});

test('JSON 未闭合被拒：这是真截断，不是文案不合格', () => {
  const broken = '{"action": "ask", "text": "data/tmp/export_draft 里有 144 个中间产物，清掉吗？只删';
  const report = parseDecisionReport(broken, EVIDENCE);
  assert.equal(report.ok, false);
  assert.equal(report.decision, null);
  assert.equal(report.scope, 'reply');
  assert.equal(report.len, charLength(broken));
  assert.ok(report.problems.some((p) => p.includes('没闭合')), report.problems.join('；'));
  assert.equal(parseDecision(broken, EVIDENCE), null);
});

test('完整合规文案通过，并且校验吃的是完整回复文本（233 字符，不是 160 的刀口）', () => {
  const report = parseDecisionReport(REAL_REPLY, EVIDENCE);
  assert.equal(report.ok, true, report.problems?.join('；'));
  assert.equal(report.decision.action, 'ask');
  assert.equal(report.decision.text, REAL_ASK_TEXT);
  assert.equal(report.len, charLength(REAL_REPLY));
  assert.ok(report.len > 160, '完整回复本来就超过 160，旧日志刀口只剩前 160');
  assert.ok(REAL_REPLY.endsWith('}'), 'JSON 是闭合的');

  // 那次被拦是长度，不是截断：只把文案换成 161 字符以上，JSON 依旧闭合
  const tooLong = REAL_REPLY.replace(REAL_ASK_TEXT, `${REAL_ASK_TEXT}${'啊'.repeat(40)}`);
  const longReport = parseDecisionReport(tooLong, EVIDENCE);
  assert.equal(longReport.ok, false);
  assert.equal(longReport.scope, 'ask');
  assert.ok(longReport.problems.some((p) => p.includes(`超过 ${ASK_MAX_CHARS} 个字符`)));
  assert.equal(longReport.text, `${REAL_ASK_TEXT}${'啊'.repeat(40)}`, '诊断贴的是 ask 文案，不是整段 JSON');
});
