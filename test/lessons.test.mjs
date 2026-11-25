/**
 * 经验折叠（lib/lessons.js）与 stage2 提示词接线的单测。
 *
 * 盯七件事：
 *   1. why 归一：只差路径/数字/候选编号的同类原因归到一起；
 *   2. 归纳：GA 路出规则句（带 GA 号与原语）、veto 路、judge 路各走各的；
 *   3. 上限：最多 5 条，命中最少（且最旧）的先淘汰；14 天没再命中自动掉出；
 *   4. 存储：lessons.json 读写往返，坏文件/坏条回退空表不炸；
 *   5. 提示词：0 条不加段，有则整段 ≤400 字，combo 已点名的 GA 不重复；
 *   6. 触发：距上次 <24h 或新增拒因 <20 条时不写盘，满足才覆写；
 *   7. 与 combo 摘要的先后：lessons 在候选表之后、combo 摘要之前。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LESSONS_PATH,
  LESSON_MAX,
  LESSON_MIN_NEW_REJECTIONS,
  LESSON_PER_PRIMITIVE_MAX,
  LESSON_PROMPT_MAX,
  collectRejections,
  consolidateIfDue,
  consolidateLessons,
  mergeLessons,
  primitiveOfRule,
  readLessons,
  renderLessonLines,
  whyKeyOf,
  writeLessons,
} from '../lib/lessons.js';
import { OBJECT_KINDS, PRIMITIVES, buildGrid } from '../lib/grid.js';
import { buildStage2Prompt } from '../lib/proposer.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ALL_PRIMITIVES = Object.fromEntries(PRIMITIVES.map((p) => [p.key, true]));
const ALL_OBJECTS = Object.fromEntries(OBJECT_KINDS.map((o) => [o.key, true]));
const MATERIALS = [{ text: '翻仓库找跑不过的测试', motivation: 'hygiene' }];
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-')), name);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-'));

let seq = 0;
/** 一条 plans.jsonl 记录：gate 明细 + 可选的 veto / judge，其余字段给最少 */
const rec = ({
  ga = 'GA21',
  action = 'downgrade',
  why = 'justify.fallback 没写回退办法',
  primitive = 'edit-file',
  ts = NOW,
  veto = null,
  judge = null,
} = {}) => {
  seq += 1;
  return {
    ts,
    callId: `c${seq}`,
    comboKey: `${primitive}|files→edit-file|files`,
    candidate: {
      pick: 'C01',
      read: { primitive: 'inspect', objectKind: 'files' },
      action: primitive ? { primitive, objectKind: 'files' } : null,
      motivation: 'hygiene',
      seed: 'seed',
    },
    gate: { items: ga ? [{ ga, action, why }] : [] },
    veto: veto ?? null,
    judge: judge ?? { action: 'silent', reason: '' },
  };
};

/* ── 归一 ─────────────────────────────────────────────────────────── */

test('whyKeyOf：路径 / 数字 / 候选编号不同也归成同一个键', () => {
  const a = whyKeyOf('undo.howto 没命中 edit-file 的撤回模板：/srv/a.js 第 12 行，候选 C01');
  const b = whyKeyOf('undo.howto 没命中 edit-file 的撤回模板：/home/x/b.md 第 987 行，候选 C02');
  assert.equal(a, b);
  assert.ok(a.length > 0);
  assert.ok(a.length <= 24);
});

test('whyKeyOf：空原因给空键', () => {
  assert.equal(whyKeyOf(''), '');
  assert.equal(whyKeyOf(null), '');
});

/* ── 归纳 ─────────────────────────────────────────────────────────── */

test('GA 路：同一关同类原因累计命中，规则句带 GA 号与原语', () => {
  const records = [rec(), rec(), rec({ primitive: 'edit-config', why: 'justify.fallback 没写回退办法：/a/b.yml 第 12 行' })];
  const { groups, rejections } = collectRejections(records, { nowMs: NOW });
  assert.equal(rejections, 3);
  assert.equal(groups.size, 1, '三条是同一组');
  const group = [...groups.values()][0];
  assert.equal(group.source, 'ga');
  assert.equal(group.hits, 3);
  assert.match(group.ruleText, /GA21/);
  assert.match(group.ruleText, /降级/);
  assert.match(group.ruleText, /edit-file/, '原语取组里出现最多的那个');
});

test('veto 与 judge 各走一路', () => {
  const records = [
    rec({ ga: '', veto: { ok: false, ran: true, hit: { rule: 'no-repeat', reason: '这一格刚做过' } } }),
    rec({ ga: '', veto: { ok: false, ran: true, hit: { rule: 'no-repeat', reason: '这一格刚做过：/x/y.js' } } }),
    rec({ ga: '', judge: { action: 'silent', reason: '方案没有可核的锚点' } }),
    rec({ ga: '', judge: { action: 'silent', reason: '方案没有可核的锚点' } }),
  ];
  const { groups } = collectRejections(records, { nowMs: NOW });
  const vetoGroup = [...groups.values()].find((one) => one.source === 'veto');
  const judgeGroup = [...groups.values()].find((one) => one.source === 'judge');
  assert.ok(vetoGroup, 'veto 要单独成组');
  assert.equal(vetoGroup.hits, 2);
  assert.match(vetoGroup.ruleText, /否决台账常拦/);
  assert.match(vetoGroup.ruleText, /no-repeat/);
  assert.ok(judgeGroup, 'judge 要单独成组');
  assert.equal(judgeGroup.hits, 2);
  assert.match(judgeGroup.ruleText, /终审常打回/);
});

test('unsupported（未核）不算拒因，窗口外记录不算', () => {
  const records = [
    rec({ ga: 'GA17', action: 'unsupported', why: '素材里没有可认的文件锚点' }),
    rec({ ts: NOW - 20 * DAY }),
  ];
  const { rejections, groups } = collectRejections(records, { nowMs: NOW, windowDays: 14 });
  assert.equal(rejections, 0);
  assert.equal(groups.size, 0);
});

test('同一条记录里 reject 与 downgrade 都算，但按各自动作分组', () => {
  const one = rec({ ga: 'GA7', action: 'reject', why: 'undo.howto 没命中模板' });
  one.gate.items.push({ ga: 'GA7', action: 'downgrade', why: 'undo.howto 没命中模板' });
  const { groups, rejections } = collectRejections([one], { nowMs: NOW });
  assert.equal(rejections, 2);
  assert.equal(groups.size, 2);
  assert.equal([...groups.values()].find((g) => g.action === 'reject').hits, 1);
});

/* ── 上限与淘汰 ───────────────────────────────────────────────────── */

const lessonOf = (id, hits, lastSeen = NOW, rule = `规则 ${id}`) => ({
  id, rule, source: 'ga', hits, firstSeen: NOW - DAY, lastSeen,
});

test('上限：最多 5 条，命中最少的先淘汰', () => {
  const old = [lessonOf('a', 9), lessonOf('b', 8), lessonOf('c', 7), lessonOf('d', 6), lessonOf('e', 2)];
  const groups = new Map([
    ['f', { id: 'f', source: 'ga', ruleText: '规则 f', hits: 10, firstSeen: NOW, lastSeen: NOW }],
  ]);
  const out = mergeLessons(old, groups, { nowMs: NOW });
  assert.equal(out.lessons.length, LESSON_MAX);
  const ids = out.lessons.map((one) => one.id);
  assert.ok(ids.includes('f'));
  assert.ok(!ids.includes('e'), '命中 2 的 e 被挤出');
});

test('陈旧淘汰：14 天没再命中的规则掉出', () => {
  const old = [lessonOf('stale', 99, NOW - 15 * DAY), lessonOf('fresh', 1, NOW - DAY)];
  const out = mergeLessons(old, new Map(), { nowMs: NOW });
  assert.deepEqual(out.lessons.map((one) => one.id), ['fresh']);
  assert.equal(out.dropped, 1);
});

test('命中过的旧规则累加 hits、刷新 lastSeen', () => {
  const old = [lessonOf('ga|GA21|downgrade|justifyfallback', 2, NOW - 2 * DAY)];
  const groups = new Map([
    ['ga|GA21|downgrade|justifyfallback', {
      id: 'ga|GA21|downgrade|justifyfallback', source: 'ga', ruleText: '新句子', hits: 3, firstSeen: NOW, lastSeen: NOW,
    }],
  ]);
  const out = mergeLessons(old, groups, { nowMs: NOW });
  assert.equal(out.lessons[0].hits, 5);
  assert.equal(out.lessons[0].rule, '新句子');
  assert.equal(out.lessons[0].lastSeen, NOW);
  assert.equal(out.added, 0, '旧表已有，不算新增');
});

test('consolidateLessons：端到端出规则并报新增条数', () => {
  const records = [];
  for (let i = 0; i < 25; i += 1) records.push(rec({ why: `缺回退办法 ${i}` }));
  const out = consolidateLessons({ lessons: [], records, nowMs: NOW });
  assert.equal(out.rejections, 25);
  assert.equal(out.lessons.length, 1);
  assert.equal(out.added, 1);
  assert.equal(out.lessons[0].hits, 25);
});

/* ── 存储 ─────────────────────────────────────────────────────────── */

test('readLessons：文件不在给空表，bad=0', () => {
  const out = readLessons(tmpFile('nope.json'));
  assert.deepEqual(out.lessons, []);
  assert.equal(out.bad, 0);
  assert.equal(out.lastConsolidateAt, 0);
});

test('readLessons：坏 JSON 回退空表，不炸', () => {
  const file = tmpFile('broken.json');
  fs.writeFileSync(file, '{不是 json', 'utf8');
  const out = readLessons(file);
  assert.deepEqual(out.lessons, []);
  assert.equal(out.bad, 1);
});

test('readLessons：坏条目丢掉、好条目留下', () => {
  const file = tmpFile('partial.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    lastConsolidateAt: 123,
    lessons: [{ id: 'x', rule: '留', source: 'veto', hits: 2, firstSeen: 1, lastSeen: 2 }, { id: 'no-rule' }, null],
  }), 'utf8');
  const out = readLessons(file);
  assert.equal(out.lessons.length, 1);
  assert.equal(out.lessons[0].source, 'veto');
  assert.equal(out.bad, 2);
  assert.equal(out.lastConsolidateAt, 123);
});

test('writeLessons 往返：只落六个字段 + 顶层锚点', () => {
  const file = tmpFile('round.json');
  const lessons = [lessonOf('a', 3)];
  assert.equal(writeLessons(file, { lessons, lastConsolidateAt: NOW }), true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(parsed.lessons[0]).sort(), ['firstSeen', 'hits', 'id', 'lastSeen', 'rule', 'source']);
  assert.equal(parsed.lastConsolidateAt, NOW);
  assert.deepEqual(readLessons(file).lessons, lessons);
});

test('默认路径在 ~/.dsh-ego 下', () => {
  assert.equal(DEFAULT_LESSONS_PATH, path.join(os.homedir(), '.dsh-ego', 'lessons.json'));
});

/* ── 提示词 ───────────────────────────────────────────────────────── */

test('渲染：0 条不加段', () => {
  assert.deepEqual(renderLessonLines([]), []);
  assert.deepEqual(renderLessonLines(null), []);
  assert.deepEqual(renderLessonLines([{ id: 'x', rule: '' }]), []);
});

test('渲染：有规则时一句一行，整段 ≤400 字', () => {
  const lessons = [lessonOf('a', 5), lessonOf('b', 3)];
  const lines = renderLessonLines(lessons);
  assert.match(lines[0], /近期反复被拦的毛病/);
  assert.ok(lines.slice(1).every((one) => one.startsWith('· ')));
  assert.ok([...lines.join('\n')].length <= LESSON_PROMPT_MAX);
});

test('渲染：规则特别长时截断到 400 字以内', () => {
  const lessons = Array.from({ length: 6 }, (_, i) => lessonOf(`l${i}`, 10 - i, NOW, '很长的规则'.repeat(40)));
  const text = renderLessonLines(lessons).join('\n');
  assert.ok([...text].length <= LESSON_PROMPT_MAX, `实际 ${[...text].length} 字`);
  assert.ok(text.endsWith('…'));
});

test('渲染：combo 已点名的 GA 不重复出现', () => {
  const lessons = [
    { id: 'ga|GA21|downgrade|abc', rule: 'GA21 的规则', source: 'ga', hits: 9, firstSeen: NOW, lastSeen: NOW },
    { id: 'ga|GA7|downgrade|def', rule: 'GA7 的规则', source: 'ga', hits: 8, firstSeen: NOW, lastSeen: NOW },
  ];
  const lines = renderLessonLines(lessons, { excludeGa: ['GA21'] }).join('\n');
  assert.ok(!lines.includes('GA21'));
  assert.match(lines, /GA7/);
});

/* ── 提示词接线 ───────────────────────────────────────────────────── */

const gridArgs = { materials: MATERIALS, primitives: ALL_PRIMITIVES, objects: ALL_OBJECTS, now: NOW, seed: 20261125 };
const candidate = buildGrid(gridArgs)[0];

test('buildStage2Prompt：有 lessons 才出现，且排在候选表之后、combo 摘要之前', () => {
  const lessons = [lessonOf('ga|GA21|downgrade|x', 9, NOW, 'edit-file 方案先过 GA21：fallback 要有回退命令')];
  const comboHistory = { win: 0, loss: 3, total: 3, reasons: ['GA17：素材里没有可认的文件锚点'] };
  const prompt = buildStage2Prompt([candidate], MATERIALS, { now: new Date(NOW), lessons, comboHistory });
  const lessonAt = prompt.indexOf('近期反复被拦的毛病');
  const candidateAt = prompt.indexOf('候选表');
  const comboAt = prompt.indexOf('这一对历史');
  assert.ok(lessonAt > candidateAt);
  assert.ok(comboAt > lessonAt, 'lessons 在 combo 摘要之前');
  assert.match(prompt, /GA21：fallback 要有回退命令/);
});

test('buildStage2Prompt：没有 lessons 时一个字不加', () => {
  const prompt = buildStage2Prompt([candidate], MATERIALS, { now: new Date(NOW) });
  assert.ok(!prompt.includes('近期反复被拦的毛病'));
});

test('buildStage2Prompt：combo 摘要点到的 GA 不会在 lessons 段重复', () => {
  const lessons = [
    lessonOf('ga|GA21|downgrade|x', 9, NOW, 'GA21 的全局规则'),
    lessonOf('ga|GA7|downgrade|y', 8, NOW, 'GA7 的全局规则'),
  ];
  const comboHistory = { win: 0, loss: 2, total: 2, reasons: ['GA21：三问没答'] };
  const prompt = buildStage2Prompt([candidate], MATERIALS, { now: new Date(NOW), lessons, comboHistory });
  const lessonBlock = prompt.slice(prompt.indexOf('近期反复被拦的毛病'), prompt.indexOf('这一对历史'));
  assert.ok(!lessonBlock.includes('GA21'));
  assert.match(lessonBlock, /GA7/);
});

/* ── 触发条件 ─────────────────────────────────────────────────────── */

test('consolidateIfDue：不足 24h 不重算也不写盘', () => {
  const file = tmpFile('due.json');
  let writes = 0;
  const out = consolidateIfDue({
    file,
    records: Array.from({ length: 30 }, () => rec()),
    state: { lessons: [], lastConsolidateAt: NOW - 60 * 60 * 1000, bad: 0 },
    nowMs: NOW,
    writeFile: () => { writes += 1; },
  });
  assert.equal(out.consolidated, false);
  assert.equal(out.added, 0);
  assert.equal(writes, 0);
});

test('consolidateIfDue：窗口内新增拒因不足 20 条不写盘', () => {
  const file = tmpFile('few.json');
  let writes = 0;
  const records = Array.from({ length: LESSON_MIN_NEW_REJECTIONS - 1 }, () => rec());
  const out = consolidateIfDue({
    file,
    records,
    nowMs: NOW,
    writeFile: () => { writes += 1; },
  });
  assert.equal(out.consolidated, false);
  assert.equal(out.rejections, LESSON_MIN_NEW_REJECTIONS - 1);
  assert.equal(writes, 0);
});

test('consolidateIfDue：满 24h 且新增够 20 条才覆写并更新锚点', () => {
  const file = tmpFile('go.json');
  const records = Array.from({ length: 21 }, () => rec());
  const out = consolidateIfDue({ file, records, nowMs: NOW });
  assert.equal(out.consolidated, true);
  assert.equal(out.added, 1);
  assert.equal(out.lessons.length, 1);
  assert.equal(out.lessons[0].hits, 21);
  const onDisk = readLessons(file);
  assert.equal(onDisk.lastConsolidateAt, NOW);
  assert.equal(onDisk.lessons[0].hits, 21);
});

test('consolidateIfDue：缓存文件读坏时按空表跑，不抛', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'lessons.json');
  fs.writeFileSync(file, '坏掉了', 'utf8');
  const out = consolidateIfDue({ file, records: [], nowMs: NOW });
  assert.equal(out.bad, 1);
  assert.equal(out.consolidated, false);
  assert.deepEqual(out.lessons, []);
});

/* ── 每原语配额 ───────────────────────────────────────────────────── */

test('配额：同一原语最多 2 条，其余顺延给别的原语', () => {
  assert.equal(LESSON_PER_PRIMITIVE_MAX, 2);
  const group = (id, ruleText, hits) => ({ id, source: 'ga', ruleText, hits, firstSeen: NOW - DAY, lastSeen: NOW });
  const groups = new Map([
    ['d1', group('d1', 'delete 这类方案先过 GA6（降级）：影响面是空的', 75)],
    ['d2', group('d2', 'delete 这类方案先过 GA8（降级）：没有外部证据', 33)],
    ['d3', group('d3', 'delete 这类方案先过 GA7（降级）：撤回模板没命中', 32)],
    ['e1', group('e1', 'edit-file 这类方案先过 GA7（降级）：撤回模板没命中', 27)],
    ['c1', group('c1', 'edit-config 这类方案先过 GA7（降级）：撤回模板没命中', 22)],
    ['p1', group('p1', 'draft 这类方案先过 GA7（降级）：撤回模板没命中', 19)],
  ]);
  const out = mergeLessons([], groups, { nowMs: NOW });
  assert.equal(out.lessons.length, LESSON_MAX, '总数仍是 5');
  const prims = out.lessons.map((one) => primitiveOfRule(one.rule));
  assert.equal(prims.filter((one) => one === 'delete').length, LESSON_PER_PRIMITIVE_MAX);
  assert.ok(new Set(prims).size >= 4, `覆盖原语 ${prims.join(',')}`);
  assert.deepEqual(prims, ['delete', 'delete', 'edit-file', 'edit-config', 'draft'], '按 hits 顺延');
  assert.equal(out.lessons[0].hits, 75);
});

test('配额：认不出原语的条目（veto / judge 两路）不占配额', () => {
  const group = (id, ruleText, hits, source = 'ga') => ({ id, source, ruleText, hits, firstSeen: NOW - DAY, lastSeen: NOW });
  const groups = new Map([
    ['d1', group('d1', 'delete 这类方案先过 GA6（降级）：影响面是空的', 50)],
    ['d2', group('d2', 'delete 这类方案先过 GA8（降级）：没有外部证据', 40)],
    ['d3', group('d3', 'delete 这类方案先过 GA7（降级）：撤回模板没命中', 30)],
    ['v1', group('v1', '否决台账常拦「no-repeat」：这一格刚做过', 20, 'veto')],
    ['j1', group('j1', '终审常打回：方案没有可核的锚点', 10, 'judge')],
    ['e1', group('e1', 'edit-file 这类方案先过 GA7（降级）：撤回模板没命中', 5)],
  ]);
  const out = mergeLessons([], groups, { nowMs: NOW });
  const prims = out.lessons.map((one) => primitiveOfRule(one.rule));
  assert.equal(prims.filter((one) => one === 'delete').length, 2);
  assert.ok(prims.includes(''), 'veto / judge 那条照常进来');
  assert.equal(out.lessons.length, 5);
});

test('配额：可注入阈值；全是一个原语时宁可少于 5 条也不硬凑', () => {
  const group = (id, hits) => ({ id, source: 'ga', ruleText: `delete 这类方案先过 ${id}（降级）：x`, hits, firstSeen: NOW - DAY, lastSeen: NOW });
  const groups = new Map([['g1', group('GA6', 5)], ['g2', group('GA7', 4)], ['g3', group('GA8', 3)]]);
  assert.equal(mergeLessons([], groups, { nowMs: NOW, maxPerPrimitive: 1 }).lessons.length, 1);
  assert.equal(mergeLessons([], groups, { nowMs: NOW }).lessons.length, 2);
});

test('primitiveOfRule：只认 ruleOf 的固定前缀，自由文本给空串', () => {
  assert.equal(primitiveOfRule('delete 这类方案先过 GA6（降级）：x'), 'delete');
  assert.equal(primitiveOfRule('edit-file 这类方案先过 GA7（降级）：x'), 'edit-file');
  assert.equal(primitiveOfRule('否决台账常拦「no-repeat」：这一格刚做过'), '');
  assert.equal(primitiveOfRule('终审常打回：方案没有可核的锚点'), '');
  assert.equal(primitiveOfRule(''), '');
  assert.equal(primitiveOfRule(null), '');
});
