/**
 * 裁决器单测：JSON 解析（正常 / 缺字段 / 非 JSON / action 非法）、brief 列宽截断、提示词
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  BRIEF_MAX_COLUMNS,
  buildJudgePrompt,
  columns,
  formatGap,
  formatTime,
  parseDecision,
  truncateColumns,
} from '../lib/judge.js';

const BACKUP_DIR = path.join(os.tmpdir(), 'backup');

test('正常三种裁决都解析得出来', () => {
  const silent = parseDecision('{"action":"silent","reason":"没什么可说的"}');
  assert.deepEqual(silent, { action: 'silent', text: '', ticket: null, reason: '没什么可说的' });

  const askText =
    `${BACKUP_DIR} 里 12 个 2025 年的旧备份，原件早就没了，` +
    '占着 3.2 GB 空间，现在磁盘只剩 15%。删掉这 12 个吗？删了不可恢复，不删就继续占地方。';
  const ask = parseDecision(`{"action":"ask","text":"${askText}","reason":"删了不可恢复"}`, {
    idea: `${BACKUP_DIR} 里 12 个 2025 年的旧备份该清`,
    why: '占着 3.2 GB 空间，现在磁盘只剩 15%',
  });
  assert.equal(ask.action, 'ask');
  assert.equal(ask.text, askText);
  assert.equal(ask.ticket, null);

  const doo = parseDecision('{"action":"do","ticket":{"goal":"把 dsh-timer 的 TODO 补完","brief":"补 TODO"},"reason":"小改动能撤回"}');
  assert.equal(doo.action, 'do');
  assert.deepEqual(doo.ticket, { goal: '把 dsh-timer 的 TODO 补完', brief: '补 TODO' });
});

test('围栏、前后废话、大小写动作都能认', () => {
  const text = '想好了：\n```json\n{"action": "DO", "ticket": {"goal": "跑一遍单测"}, "reason": "能重跑"}\n```\n就这样。';
  const parsed = parseDecision(text);
  assert.equal(parsed.action, 'do');
  assert.equal(parsed.ticket.goal, '跑一遍单测');
});

test('缺字段、非 JSON、动作非法一律 null（这一拍算失败）', () => {
  assert.equal(parseDecision('不是 json'), null);
  assert.equal(parseDecision(''), null);
  assert.equal(parseDecision(null), null);
  assert.equal(parseDecision('{"text":"没有动作"}'), null, '缺 action');
  assert.equal(parseDecision('{"action":"report","reason":"乱写的"}'), null, 'action 非法');
  assert.equal(parseDecision('{"action":"ask","reason":"忘了写话"}'), null, 'ask 没有 text');
  assert.equal(
    parseDecision('{"action":"ask","text":"55 条死账删了捞不回来，用户点头再动？"}'),
    null,
    'ask 文案用了禁词也不许过关',
  );
  assert.equal(parseDecision('{"action":"do","reason":"忘了写活"}'), null, 'do 没有 ticket.goal');
  assert.equal(parseDecision('{"action":"do","ticket":{"goal":"   "}}'), null, 'goal 只有空白');
  // 模型偶尔套一层数组：取第一个配对的对象，宽容但不瞎编
  assert.equal(parseDecision('[{"action":"silent"}]').action, 'silent', '数组包裹里唯一的对象要认');
  assert.equal(parseDecision('{"action":'), null, '断掉的 JSON');
});

test('brief 按列宽截断：汉字算 2 列，空 brief 用 goal 兜底', () => {
  const long = '把那个已经三个月没人动的旧博客备份删掉吧';
  const parsed = parseDecision(`{"action":"do","ticket":{"goal":"${long}","brief":"${long}"}}`);
  assert.ok(columns(parsed.ticket.brief) <= BRIEF_MAX_COLUMNS, `超了：${parsed.ticket.brief}`);
  assert.equal(columns(parsed.ticket.brief), BRIEF_MAX_COLUMNS);

  const fallback = parseDecision('{"action":"do","ticket":{"goal":"补 TODO"}}');
  assert.equal(fallback.ticket.brief, '补 TODO');

  assert.equal(columns('鲸鱼娘'), 6);
  assert.equal(columns('abc'), 3);
  assert.equal(truncateColumns('鲸鱼娘鲸鱼娘', 10).length, 5);
});

test('时间给人话：formatTime / formatGap 喂给模型', () => {
  const ts = new Date(2026, 10, 8, 14, 5).getTime();
  assert.equal(formatTime(ts), '11-08 14:05');
  assert.equal(formatTime(0), '（没记过）');
  assert.equal(formatGap(ts - 45 * 60 * 1000, ts), '45 分钟前');
  assert.equal(formatGap(ts - 3 * 60 * 60 * 1000 - 20 * 60 * 1000, ts), '3 小时 20 分钟前');
  assert.equal(formatGap(0, ts), '（没记过）');
});

test('裁决器提示词：带三条原则和两个时间点，不给提议器过程', () => {
  const now = new Date(2026, 10, 8, 14, 5);
  const prompt = buildJudgePrompt({
    idea: '把 dsh-timer 的 TODO 补完',
    why: 'TODO 写了三周',
    now,
    state: {},
    lastReportAt: now.getTime() - 3 * 60 * 60 * 1000,
    lastAskAt: 0,
  });
  assert.ok(prompt.includes('把 dsh-timer 的 TODO 补完'));
  assert.ok(prompt.includes('TODO 写了三周'));
  assert.ok(prompt.includes('能撤回') || prompt.includes('可撤回'), '要写「能撤回就直接做」');
  assert.ok(prompt.includes('删日志'), '要写「删了不可恢复只能问」');
  assert.ok(prompt.includes('不到 1 天就 silent'), '汇报类要看 lastReportAt');
  assert.ok(prompt.includes('3 小时前') || prompt.includes('3 小时'), 'lastReportAt 要以文字喂进去');
  assert.ok(prompt.includes('（没记过）'), 'lastAskAt 为空也要写出来');
  assert.ok(prompt.includes('"action"'));
});
