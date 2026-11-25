/**
 * B 组合路由的历史账（lib/combo-history.js）与 grid / 提示词两处接线的单测。
 *
 * 盯五件事：
 *   1. 坏行跳过并计数，缺文件 → 空表；
 *   2. 文件按 mtime+size 缓存：没变就不重读（注入计数）；
 *   3. 同一拍多行（重写）按 callId 只取最后一行；win/loss 映射与 abort/empty 不计；
 *   4. 系数 clamp((win+1)/(loss+1), 0.4, 1.5)，多次被拒后 <1，提示词里出原因摘要；
 *   5. 空历史（null 与空 Map）同 seed 的 buildGrid 结果与改前一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMBO_FACTOR_MAX,
  COMBO_FACTOR_MIN,
  COMBO_HISTORY_LINE_MAX,
  comboHistoryFactor,
  loadComboHistory,
  outcomeOf,
  renderComboHistoryLines,
  summarize,
} from '../lib/combo-history.js';
import { PRIMITIVES, OBJECT_KINDS, buildGrid } from '../lib/grid.js';
import { buildStage2Prompt } from '../lib/proposer.js';
import { comboKey } from '../lib/combo.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const ALL_PRIMITIVES = Object.fromEntries(PRIMITIVES.map((p) => [p.key, true]));
const ALL_OBJECTS = Object.fromEntries(OBJECT_KINDS.map((o) => [o.key, true]));
const MATERIALS = [{ text: '翻仓库找跑不过的测试', motivation: 'hygiene' }];

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'combo-hist-')), name);

const row = (over = {}) => ({
  ts: NOW,
  callId: 'c1',
  comboKey: 'inspect|files→edit-file|files',
  outcome: 'decided',
  gate: { items: [] },
  veto: null,
  judge: { action: 'do', reason: '' },
  ...over,
});

const writeLines = (file, lines) => fs.writeFileSync(file, `${lines.map((one) => JSON.stringify(one)).join('\n')}\n`, 'utf8');

const gridArgs = { materials: MATERIALS, primitives: ALL_PRIMITIVES, objects: ALL_OBJECTS, now: NOW, seed: 20261125 };

/* ── 读盘与缓存 ───────────────────────────────────────────────────── */

test('缺文件：空表，不抛', () => {
  const out = loadComboHistory({ file: tmpFile('nope.jsonl') });
  assert.equal(out.table.size, 0);
  assert.equal(out.bad, 0);
});

test('坏行跳过并计数，好行照常汇总', () => {
  const file = tmpFile('plans.jsonl');
  const good = row({ callId: 'c1' });
  const loss = row({ callId: 'c2', outcome: 'gate_rejected', judge: null, gate: { items: [{ ga: 'GA21', why: '三问没答' }] } });
  fs.writeFileSync(file, `${JSON.stringify(good)}\n{坏行不是 JSON\n${JSON.stringify(loss)}\n]\n`, 'utf8');
  const out = loadComboHistory({ file });
  assert.equal(out.bad, 2);
  assert.equal(out.rows, 2);
  const entry = out.table.get('inspect|files→edit-file|files');
  assert.equal(entry.win, 1);
  assert.equal(entry.loss, 1);
});

test('缓存：mtime+size 没变时第二次不重读文件', () => {
  const file = tmpFile('cached.jsonl');
  writeLines(file, [row({ callId: 'c1' })]);
  let reads = 0;
  let stats = 0;
  const statFile = () => {
    stats += 1;
    return { mtimeMs: 111, size: 10 };
  };
  const readFile = () => {
    reads += 1;
    return `${JSON.stringify(row({ callId: 'c1' }))}\n`;
  };
  const first = loadComboHistory({ file, statFile, readFile });
  const second = loadComboHistory({ file, statFile, readFile });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(reads, 1, '第二次只 stat，不 read');
  assert.equal(stats, 2);
  assert.equal(second.table.get('inspect|files→edit-file|files').win, 1);
});

test('缓存：size 变了要重读', () => {
  const file = tmpFile('grow.jsonl');
  let size = 10;
  let reads = 0;
  const statFile = () => ({ mtimeMs: 111, size });
  const readFile = () => {
    reads += 1;
    return `${JSON.stringify(row({ callId: `c${reads}` }))}\n`;
  };
  loadComboHistory({ file, statFile, readFile });
  size = 20;
  const second = loadComboHistory({ file, statFile, readFile });
  assert.equal(second.cached, false);
  assert.equal(reads, 2);
});

/* ── 记账口径 ─────────────────────────────────────────────────────── */

test('同一 callId 多行（重写）：只取 ts 最大的最后一行', () => {
  const rows = [
    row({ callId: 'c1', ts: NOW, outcome: 'rewrite' }),
    row({ callId: 'c1', ts: NOW + 1000, outcome: 'decided' }),
  ];
  const table = summarize(rows);
  const entry = table.get('inspect|files→edit-file|files');
  assert.equal(entry.win, 1);
  assert.equal(entry.loss, 0);
  assert.equal(entry.total, 1);
});

test('callId 被遮成 ***（现网落盘就是这样）：不按它去重，逐行计数', () => {
  // plans-log 的 maskSecrets 会把 callId 遮成 ***；当成同一个 id 去重会把整份文件压成一行
  const rows = [
    row({ callId: '***', ts: NOW, outcome: 'decided' }),
    row({ callId: '***', ts: NOW + 1000, outcome: 'gate_rejected', gate: { items: [{ ga: 'GA2', why: '对象对不上' }] } }),
    row({ callId: '', ts: NOW + 2000, outcome: 'decided' }),
  ];
  const entry = summarize(rows).get('inspect|files→edit-file|files');
  assert.equal(entry.win, 2, '两条 decided+do 都算 win（被去重的话只会剩 1）');
  assert.equal(entry.loss, 1);
  assert.equal(entry.total, 3);
});

test('outcome 映射：do 记 win；gate/veto/exhausted/silent 记 loss；abort/empty/rewrite 不计', () => {
  assert.equal(outcomeOf(row({ outcome: 'decided', judge: { action: 'do' } })), 'win');
  assert.equal(outcomeOf(row({ outcome: 'decided', judge: { action: 'silent' } })), 'loss');
  assert.equal(outcomeOf(row({ outcome: 'gate_rejected' })), 'loss');
  assert.equal(outcomeOf(row({ outcome: 'veto_rejected' })), 'loss');
  assert.equal(outcomeOf(row({ outcome: 'exhausted' })), 'loss');
  for (const outcome of ['abort', 'empty', 'rewrite', '']) assert.equal(outcomeOf(row({ outcome })), null);
  // decided 但 judge.action 既不是 do 也不是 silent（ask / rewrite）不计
  assert.equal(outcomeOf(row({ outcome: 'decided', judge: { action: 'ask' } })), null);

  const table = summarize([
    row({ callId: 'w', outcome: 'decided', judge: { action: 'do' } }),
    row({ callId: 'l1', outcome: 'gate_rejected', gate: { items: [{ ga: 'GA2', why: '对象对不上' }] } }),
    row({ callId: 'l2', outcome: 'decided', judge: { action: 'silent', reason: '没新东西' } }),
    row({ callId: 'skip1', outcome: 'abort' }),
    row({ callId: 'skip2', outcome: 'empty' }),
  ]);
  const entry = table.get('inspect|files→edit-file|files');
  assert.equal(entry.win, 1);
  assert.equal(entry.loss, 2);
  assert.equal(entry.total, 3);
  assert.equal(entry.reasons.length, 2);
  assert.match(entry.reasons[0], /GA2/);
});

test('原因来源：gate 明细带 GA，veto 取 rule+reason', () => {
  const table = summarize([
    row({ callId: 'v', outcome: 'veto_rejected', veto: { ok: false, hit: { rule: 'V1', reason: '方向否过' }, ran: true } }),
  ]);
  assert.deepEqual(table.get('inspect|files→edit-file|files').reasons, ['V1：方向否过']);
});

/* ── 系数与摘要 ───────────────────────────────────────────────────── */

test('系数 clamp：空历史 1；连败压到 0.4；连胜封顶 1.5', () => {
  assert.equal(comboHistoryFactor(null), 1);
  assert.equal(comboHistoryFactor({ win: 0, loss: 0 }), 1);
  assert.equal(comboHistoryFactor({ win: 0, loss: 3 }), COMBO_FACTOR_MIN);
  assert.equal(comboHistoryFactor({ win: 2, loss: 1 }), COMBO_FACTOR_MAX);
  assert.equal(comboHistoryFactor({ win: 1, loss: 1 }), 1);
  assert.equal(comboHistoryFactor({ win: 3, loss: 0 }), COMBO_FACTOR_MAX);
});

test('摘要：只取最近 3 条、整段截到 300 字；没有原因返回空数组', () => {
  assert.deepEqual(renderComboHistoryLines(null), []);
  assert.deepEqual(renderComboHistoryLines({ win: 1, loss: 0, reasons: [] }), []);
  const lines = renderComboHistoryLines({
    win: 0,
    loss: 4,
    reasons: ['GA1：a', 'GA2：b', 'GA3：c', 'GA4：d'],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /成 0 败 4/);
  assert.match(lines[0], /GA4：d/);
  assert.equal(lines[0].includes('GA1：a'), false, '只留最近 3 条');

  const long = renderComboHistoryLines({ win: 0, loss: 1, reasons: ['x'.repeat(400)] });
  assert.ok([...long[0]].length <= COMBO_HISTORY_LINE_MAX);
  assert.ok(long[0].endsWith('…'));
});

/* ── grid 与提示词接线 ────────────────────────────────────────────── */

test('空历史（null / 空 Map）同 seed 的 buildGrid 结果与改前一致', () => {
  const before = buildGrid({ ...gridArgs });
  const withNull = buildGrid({ ...gridArgs, comboHistory: null });
  const withEmpty = buildGrid({ ...gridArgs, comboHistory: new Map() });
  assert.deepEqual(withNull, before);
  assert.deepEqual(withEmpty, before);
  // loadComboHistory 的返回形状（{table}）也认
  assert.deepEqual(buildGrid({ ...gridArgs, comboHistory: { table: new Map() } }), before);
});

test('多次被拒后：系数 <1，提示词里出现这一对的历史与最近原因', () => {
  const candidate = buildGrid({ ...gridArgs })[0];
  assert.ok(candidate, '这一组素材要能枚举出候选');
  const key = comboKey(candidate);
  const rows = [1, 2, 3].map((n) => row({
    callId: `c${n}`,
    comboKey: key,
    outcome: 'gate_rejected',
    judge: null,
    gate: { items: [{ ga: 'GA21', why: `第 ${n} 次：三问没答` }] },
  }));
  const table = summarize(rows);
  const entry = table.get(key);
  assert.equal(entry.loss, 3);
  assert.ok(comboHistoryFactor(entry) < 1);
  assert.equal(comboHistoryFactor(entry), COMBO_FACTOR_MIN);

  const prompt = buildStage2Prompt([candidate], MATERIALS, { comboHistory: entry });
  assert.match(prompt, /这一对历史：成 0 败 3/);
  assert.match(prompt, /最近被打回/);
  assert.match(prompt, /GA21：第 3 次：三问没答/);

  // 没有历史时提示词里不放这一段
  const plain = buildStage2Prompt([candidate], MATERIALS, {});
  assert.equal(plain.includes('这一对历史'), false);
});

test('历史只进随机路径的权重：确定性排序不受影响', () => {
  const keys = buildGrid({ materials: MATERIALS, primitives: ALL_PRIMITIVES, objects: ALL_OBJECTS, now: NOW })
    .map((one) => one.id);
  const history = new Map([['inspect|files→', { win: 0, loss: 5 }]]);
  const withHistory = buildGrid({
    materials: MATERIALS,
    primitives: ALL_PRIMITIVES,
    objects: ALL_OBJECTS,
    now: NOW,
    comboHistory: history,
  }).map((one) => one.id);
  assert.deepEqual(withHistory, keys);
});
