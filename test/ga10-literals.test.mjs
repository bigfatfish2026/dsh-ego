/**
 * GA10 的数字口径：只核字面，不猜哪类数字算「测量值」。
 *
 * gate 只做两件硬事：日期/时刻先遮掉；idea 里剩的每个阿拉伯数字（含小数）都要在
 * evidence[].value 里原样出现。缺的数字汇成一条 unsure 交给 arbiter——计数、定性说法、
 * 是不是编造的测量值，这些判断代码做不了，也别拿量纲词表猜。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkStage2Plan, ideaNumbersIn, maskDatesAndTimes } from '../lib/gate.js';
import { rewriteGaFix } from '../lib/proposer.js';
import { PRIMITIVES, OBJECT_KINDS } from '../lib/grid.js';

/* ── 夹具（与 gate-stage2.test.mjs 同一套口径） ────────────────────── */

const PRIMITIVE_KEY = new Map(PRIMITIVES.map((one) => [one.id, one.key]));
const OBJECT_KEY = new Map(OBJECT_KINDS.map((one) => [one.id, one.key]));

const cell = (primitive, objectKind) => ({
  primitive,
  primitiveKey: PRIMITIVE_KEY.get(primitive) ?? primitive,
  objectKind,
  objectKey: OBJECT_KEY.get(objectKind) ?? objectKind,
});

const candidate = () => ({
  id: 'C01',
  read: cell('inspect', 'files'),
  action: cell('edit-file', 'files'),
  material: '翻仓库找跑不过的测试',
  motivation: 'hygiene',
  note: '读 读 × 文件 → 动 改文件 × 文件｜有副作用 auto',
  score: 39,
  defaults: { impact: 'local-write', reversibility: 'auto' },
});

const plan = (over = {}) => ({
  pick: 'C01',
  step1: { read: 'lib/gate.js:36-70', verdict: 'continue', abortIf: '没有重复分支就 abort' },
  step2: { change: '删掉 lib/gate.js 里重复的分支', files: ['lib/gate.js'], estLines: 0, undo: 'git checkout -- lib/gate.js' },
  idea: 'lib/gate.js 里有 36 行重复分支，可以直接删掉',
  why: '上个提交复制粘贴留下的，没有别的调用方',
  object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:36' },
  evidence: [{ claim: '重复分支在第 36 行', source: 'read', value: '36', at: '2026-11-10T05:28:00Z' }],
  plan: { steps: ['P1×files', 'P2×files'], files: ['lib/gate.js'], estLines: 0 },
  intent: {
    impact: { paths: ['lib/gate.js'], services: [], remotes: [] },
    reversibility: 'auto',
    dryRun: { ok: true, detail: 'read lib/gate.js' },
    undo: { kind: '', ref: '', howto: 'git checkout -- lib/gate.js' },
  },
  ...over,
});

const check = (over) => checkStage2Plan(plan(over), { candidates: [candidate()] });
const ga10Notes = (verdict) => verdict.unsure.filter((one) => one.ga === 'GA10');

/* ── 抽取：只遮日期时刻，不筛数字 ─────────────────────────────────── */

test('ideaNumbersIn：计数、小数、行号、区间全都抽，日期时刻先遮掉', () => {
  const text = '0 个残留、3 处重复、0.1% 的可能、37.7 度、718 行、lib/gate.js:36-70，'
    + '2026-11-08 16:18:01 那拍';
  assert.deepEqual(ideaNumbersIn(text), ['0', '3', '0.1', '37.7', '718', '36', '70']);
  assert.equal(/2026|16/.test(maskDatesAndTimes('2026-11-08 16:18:01')), false);
});

/* ── 判定：逐个字面比，缺的汇成一条 arbiter case ─────────────────── */

test('数字都有出处就不过问；缺一个也只收一条 unsure', () => {
  const ok = check({});
  assert.deepEqual(ga10Notes(ok), []);
  assert.equal(ok.downgrade.some((one) => one.ga === 'GA10'), false);

  const bad = check({ idea: 'lib/gate.js 里有 36 行重复分支，另外 55 行注释也太旧' });
  const notes = ga10Notes(bad);
  assert.equal(notes.length, 1, '缺的数字汇成一条，不一个数字一条 case');
  assert.match(notes[0].why, /55/);
  assert.equal(/36/.test(notes[0].why), false, '36 有出处，不该被点名');
  assert.match(notes[0].subject, /36 行重复分支/);
  assert.match(notes[0].subject, /evidence\.value=36/);
});

test('计数、定性小数、行号都没出处时，一条 case 全列出来交 arbiter', () => {
  const bad = check({
    idea: '改了 3 处、删了 5 条，磁盘还剩 0.1% 的可能，日志 718 行也有',
    evidence: [],
  });
  const notes = ga10Notes(bad);
  assert.equal(notes.length, 1);
  assert.match(notes[0].why, /3、5、0\.1、718/);
  assert.match(notes[0].why, /计数和定性说法放行/);
  assert.equal(bad.downgrade.some((one) => one.ga === 'GA10'), false, '缺出处不再自己判死');
});

test('日期和时刻不参与核，旁边的真数字照核', () => {
  const dateOnly = check({ idea: '2026-11-10 16:18:01 那拍没什么异常', evidence: [] });
  assert.deepEqual(ga10Notes(dateOnly), []);

  const mixed = check({ idea: '2026-11-10 16:18 的日志里有 36 行重复，718 行那条也是' });
  const notes = ga10Notes(mixed);
  assert.equal(notes.length, 1);
  assert.match(notes[0].why, /718/);
  assert.equal(/36/.test(notes[0].why), false);
});

/* ── proposer 的修法跟 gate 共用同一个 ideaNumbersIn ──────────────── */

test('proposer 重写修法：缺出处的数字与 gate 同一口径，计数也列出来', () => {
  const idea = '从 3 个改成 5 个，温度 37.7 度';
  const evidence = [{ claim: '温度读数', source: 'read', value: '37.7', at: '2026-11-11T12:00:00Z' }];
  const known = new Set();
  for (const item of evidence) for (const n of ideaNumbersIn(item.value)) known.add(n);
  const missing = [...new Set(ideaNumbersIn(idea))].filter((n) => !known.has(n));

  assert.deepEqual(missing, ['3', '5'], '37.7 有出处；3、5 是计数也照列，判不判交给 arbiter');
  const fix = rewriteGaFix('GA10', 'idea 里的数字 3、5 在 evidence 的 value 里找不到出处', { idea, evidence });
  assert.match(fix, /数字 3、5 在 evidence/);
  assert.equal(/37\.7 在 evidence/.test(fix), false);
});

/* ── 源码：猜数字的那套东西不许留 ─────────────────────────────────── */

test('gate 源码里没有量纲词表 / 行号特判的残留', () => {
  const source = fs.readFileSync(new URL('../lib/gate.js', import.meta.url), 'utf8');
  for (const gone of ['IDEA_DIMENSION_WORDS', 'DIMENSION_WORDS_BY_LENGTH', 'hasDimensionWordAfter', 'isLineNumberContext', 'IDEA_NUMBER_MIN', 'NUMBER_DIMENSION', 'PLACEHOLDER_FILE_PATTERN', 'materialFileNames', 'pathTailMatches', 'pairShape']) {
    assert.equal(source.includes(gone), false, `${gone} 应该已经删干净`);
  }
});
