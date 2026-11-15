/**
 * extractJson 的「只差最外层一个 }」兜底。
 *
 * 事故：21:18 那拍终审回复 609 字符，`{` 6 个、`}` 5 个，唯一没闭的是 offset 0 的最外层。
 * 不是流截断、不是引号问题，就是模型漏写了最外层收尾。兜底只补这一个，多缺的不猜。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../lib/agent-run.js';
import { parseDecisionReport } from '../lib/gate.js';

/** 模拟那拍：最外层少了收尾 } */
const MISSING_OUTER = '{"action": "silent", "text": "", "ticket": {"goal": "", "brief": ""}, "reason": "今天没什么，先不动"';

test('差一个 }：补上末尾那一个就解析成功，meta 带回 repaired', () => {
  const meta = {};
  const value = extractJson(MISSING_OUTER, meta);
  assert.deepEqual(value, { action: 'silent', text: '', ticket: { goal: '', brief: '' }, reason: '今天没什么，先不动' });
  assert.equal(meta.repaired, 1);
  assert.equal(meta.added, 1);
});

test('差两个 }：不补，仍返回 null，meta 不带 repaired', () => {
  const meta = {};
  const value = extractJson('{"action": "do", "ticket": {"goal": "清缓存"', meta);
  assert.equal(value, null);
  assert.equal(meta.repaired, undefined);
});

test('正常闭合：行为一个字没变，meta 不带 repaired', () => {
  const meta = {};
  const value = extractJson('{"a": 1}', meta);
  assert.deepEqual(value, { a: 1 });
  assert.equal(meta.repaired, undefined);
});

test('前面有废话 / 围栏：照旧取第一个对象，差一个 } 也能补', () => {
  assert.deepEqual(extractJson('先说两句。```json\n{"a": {"b": 2}}\n```\n再说两句'), { a: { b: 2 } });
  const meta = {};
  const value = extractJson('好，按你说的来：\n```json\n{"a": {"b": 2}', meta);
  assert.deepEqual(value, { a: { b: 2 } });
  assert.equal(meta.repaired, 1);
  // 尾巴上还剩围栏/空白就不补了：那已经不只是差一个 }，不猜
  assert.equal(extractJson('```json\n{"a": 1\n```'), null);
});

test('平衡对象后面还有内容：照旧只取第一个，不触发修补', () => {
  const meta = {};
  const value = extractJson('{"a": 1} 后面还有 {"b": 2}', meta);
  assert.deepEqual(value, { a: 1 });
  assert.equal(meta.repaired, undefined);
});

test('字符串里的括号 / 转义不受影响', () => {
  const meta = {};
  const value = extractJson('{"a": "}"}', meta);
  assert.deepEqual(value, { a: '}' });
  assert.equal(meta.repaired, undefined);
});

test('parseDecisionReport：补成功照常通过，并打一行 json_repaired 日志', () => {
  const lines = [];
  const report = parseDecisionReport(MISSING_OUTER, { log: (line) => lines.push(line) });
  assert.equal(report.ok, true, `补完应该能用，实际：${report.problems.join('；')}`);
  assert.equal(report.decision.action, 'silent');
  assert.deepEqual(lines, ['json_repaired:1｜补了末尾 1 个 }']);
});

test('parseDecisionReport：正常闭合不打 repaired 日志', () => {
  const lines = [];
  const report = parseDecisionReport('{"action": "silent", "text": "", "ticket": {"goal": "", "brief": ""}, "reason": "没事"}', {
    log: (line) => lines.push(line),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(lines, []);
});

test('parseDecisionReport：差两个 } 仍失败，报错文案不变', () => {
  const lines = [];
  const report = parseDecisionReport('{"action": "do", "ticket": {"goal": "清缓存"', { log: (line) => lines.push(line) });
  assert.equal(report.ok, false);
  assert.equal(report.decision, null);
  assert.deepEqual(report.problems, ['回复里的 JSON 没闭合（写到一半被截断，或后面的字把 } 吞了）']);
  assert.deepEqual(lines, []);
});
