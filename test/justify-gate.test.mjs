/**
 * GA21：stage2 方案三问（gain / surface / fallback）的单测。
 *
 * 盯四件事：
 *   1. 三栏都答得具体 → 放行；答空话 / 答得太短 / gain 没有落点 → downgrade GA21（code=GA21，落 silent）；
 *   2. 三种自相矛盾（surface 说不新增却有 P4~P7、fallback 说回不去却 auto/manual、说无需回退却 none）；
 *   3. 开关口径：写了就判；没写时 required=true 判、false 只记 note（replay 老记录不判 worse）；
 *   4. parseStage2Plan 把 justify 原样透传，缺省 null。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JUSTIFY_EMPTY_TALK,
  JUSTIFY_MIN_CHARS,
  REWRITE_GATE_ACTIONS,
  checkJustify,
  checkStage2Plan,
  parseJustify,
} from '../lib/gate.js';
import { parseStage2Plan } from '../lib/proposer.js';
import { buildPlanRecord } from '../lib/plans-log.js';
import { replayPlan } from '../lib/replay.js';

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const cell = (primitive, objectKind) => ({
  primitive,
  primitiveKey: primitive,
  objectKind,
  objectKey: objectKind,
});

const CANDIDATE = {
  id: 'C01',
  read: cell('inspect', 'files'),
  action: cell('edit-file', 'files'),
  material: '翻仓库找跑不过的测试',
  motivation: 'hygiene',
  defaults: { impact: 'local-write', reversibility: 'auto' },
};

/** 一份能过其余关的方案；justify 由用例覆盖 */
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
  justify: {
    gain: '同一处重复分支从 36 行减到 12 行，判据在 gate.js:36',
    surface: '删掉重复分支后 gate.js 少一层嵌套，改一处不用同步两处',
    fallback: 'git checkout -- lib/gate.js 就能回到改前',
  },
  ...over,
});

const CHECK_OPTS = { candidates: [CANDIDATE] };
const gAs = (list) => list.map((one) => one.ga);
const ga21 = (verdict) => verdict.downgrade.find((one) => one.ga === 'GA21');

/* ── 常量与形状 ───────────────────────────────────────────────────── */

test('GA21 常量：最短 8 字、空话词表导出、落点是 silent', () => {
  assert.equal(JUSTIFY_MIN_CHARS, 8);
  assert.ok(JUSTIFY_EMPTY_TALK.includes('提升'));
  assert.ok(JUSTIFY_EMPTY_TALK.includes('暂无'));
  assert.equal(REWRITE_GATE_ACTIONS.GA21, 'silent');
});

test('parseJustify：三项都收成字符串；不是对象 / 三项全空 → null', () => {
  assert.deepEqual(parseJustify({ gain: ' a ', surface: 'b', fallback: 'c' }), { gain: 'a', surface: 'b', fallback: 'c' });
  assert.equal(parseJustify(null), null);
  assert.equal(parseJustify('gain=x'), null);
  assert.equal(parseJustify({}), null);
  assert.equal(parseJustify({ gain: '  ', surface: '' }), null);
});

/* ── 正例 ─────────────────────────────────────────────────────────── */

test('三问都答得具体：放行，不命中 GA21', () => {
  const verdict = checkStage2Plan(plan(), CHECK_OPTS);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.allowDo, true);
  assert.equal(gAs(verdict.downgrade).includes('GA21'), false);
  assert.equal(verdict.hits.includes('GA21'), false);
  assert.equal(gAs(verdict.notes ?? []).length, 0);
});

test('checkJustify 直接调：正例返回 null', () => {
  assert.equal(checkJustify(plan(), { required: true }), null);
});

/* ── 空话 ─────────────────────────────────────────────────────────── */

test('gain 只写「提升」：空话，downgrade GA21', () => {
  const verdict = checkStage2Plan(plan({ justify: { ...plan().justify, gain: '提升' } }), CHECK_OPTS);
  const hit = ga21(verdict);
  assert.ok(hit, '要命中 GA21');
  assert.equal(hit.code, 'GA21');
  assert.equal(hit.originalAction, 'silent');
  assert.match(hit.why, /justify\.gain/);
  assert.match(hit.why, /空话/);
});

test('某项去标点后不足 8 字：空话', () => {
  const verdict = checkStage2Plan(plan({
    justify: { ...plan().justify, fallback: '回滚，重来。' },
  }), CHECK_OPTS);
  const hit = ga21(verdict);
  assert.ok(hit);
  assert.match(hit.why, /justify\.fallback/);
});

test('gain 没数字、没点到对象/文件/证据：命中 GA21', () => {
  const verdict = checkStage2Plan(plan({
    justify: {
      ...plan().justify,
      gain: '让方案更可审计，读的人一眼能看懂为什么值得做',
    },
  }), CHECK_OPTS);
  const hit = ga21(verdict);
  assert.ok(hit);
  assert.match(hit.why, /既没有数字/);
});

test('gain 点到 plan.files 里的路径也算有落点', () => {
  const verdict = checkStage2Plan(plan({
    justify: {
      ...plan().justify,
      gain: '把 lib/gate.js 里重复的那一段收掉，后面改这一处不用同步两份',
    },
  }), CHECK_OPTS);
  assert.equal(gAs(verdict.downgrade).includes('GA21'), false);
});

/* ── 三种自相矛盾 ─────────────────────────────────────────────────── */

test('surface 写不新增，plan.steps 里却有 P4：命中 GA21', () => {
  const verdict = checkStage2Plan(plan({
    plan: { steps: ['P1×files', 'P2×files', 'P4×files'], files: ['lib/gate.js'], estLines: 0 },
    justify: { ...plan().justify, surface: '不新增能力面，只是把重复代码收掉' },
  }), CHECK_OPTS);
  const hit = ga21(verdict);
  assert.ok(hit);
  assert.match(hit.why, /plan\.steps 里有 P4/);
});

test('surface 说不新增但只动文件/配置：不算矛盾', () => {
  const verdict = checkStage2Plan(plan({
    justify: { ...plan().justify, surface: '不新增能力面，只把 gate.js 的重复分支收掉' },
  }), CHECK_OPTS);
  assert.equal(gAs(verdict.downgrade).includes('GA21'), false);
});

test('fallback 说回不去，reversibility=auto：命中 GA21', () => {
  const verdict = checkStage2Plan(plan({
    justify: { ...plan().justify, fallback: '改坏了也回不去，只能手工重来一遍' },
  }), CHECK_OPTS);
  const hit = ga21(verdict);
  assert.ok(hit);
  assert.match(hit.why, /reversibility=auto/);
});

test('fallback 说无需回退，reversibility=none：命中 GA21', () => {
  const verdict = checkStage2Plan(plan({
    intent: { ...plan().intent, reversibility: 'none' },
    justify: { ...plan().justify, fallback: '这一步无需回退，直接往前做就行' },
  }), CHECK_OPTS);
  const hit = ga21(verdict);
  assert.ok(hit);
  assert.match(hit.why, /reversibility=none/);
});

test('fallback 说回不去 + reversibility=none：不矛盾', () => {
  const verdict = checkStage2Plan(plan({
    intent: { ...plan().intent, reversibility: 'none' },
    justify: { ...plan().justify, fallback: '发出去就收不回，回不去时只能重新读一遍再判断' },
  }), CHECK_OPTS);
  assert.equal(gAs(verdict.downgrade).includes('GA21'), false);
});

/* ── 开关口径与 replay 兼容 ───────────────────────────────────────── */

test('没有 justify：required=true 判 GA21；required=false 只记 note', () => {
  const bare = plan();
  delete bare.justify;
  const required = checkStage2Plan(bare, { ...CHECK_OPTS, justifyRequired: true });
  assert.ok(ga21(required));
  assert.match(ga21(required).why, /没答三问/);

  const legacy = checkStage2Plan(bare, CHECK_OPTS);
  assert.equal(gAs(legacy.downgrade).includes('GA21'), false);
  assert.equal(legacy.hits.includes('GA21'), false);
  assert.ok(legacy.notes.some((one) => one.includes('GA21') && one.includes('未判')));
});

test('写了就判：required=false 时空话照样降级（replay 要能看见 GA21）', () => {
  const verdict = checkStage2Plan(
    plan({ justify: { ...plan().justify, gain: '优化' } }),
    CHECK_OPTS,
  );
  assert.ok(ga21(verdict));
});

test('pick 空 / verdict=abort：不判 GA21（checkJustify 也不命中）', () => {
  const aborted = plan({ step1: { read: 'lib/gate.js:36', verdict: 'abort', abortIf: '没有重复分支就 abort' }, justify: null });
  assert.equal(checkJustify(aborted, { required: true }), null);
  assert.equal(gAs(checkStage2Plan(aborted, { ...CHECK_OPTS, justifyRequired: true }).downgrade).includes('GA21'), false);
});

test('replay 旧记录没有 justify：changed=same，不判 worse', async () => {
  const legacy = plan();
  delete legacy.justify;
  const record = buildPlanRecord({
    ts: Date.parse('2026-11-10T12:00:00Z'),
    callId: 'call-legacy',
    comboKey: 'inspect|files→edit-file|files',
    candidate: {
      pick: 'C01',
      read: { primitive: 'inspect', primitiveKey: 'inspect', objectKind: 'files', objectKey: 'files' },
      action: { primitive: 'edit-file', primitiveKey: 'editFile', objectKind: 'files', objectKey: 'files' },
      motivation: 'hygiene',
      seed: '翻仓库找跑不过的测试',
    },
    plan: legacy,
    verdict: null,
    outcome: 'decided',
    round: 0,
    gridSeed: 1,
  });
  const out = await replayPlan(record, {});
  assert.equal(out.changed, 'same', `老记录不判 worse（after=${JSON.stringify(out.after)}）`);
  assert.equal(out.after.some((one) => one.ga === 'GA21'), false);
});

/* ── parseStage2Plan 透传 ─────────────────────────────────────────── */

test('parseStage2Plan：continue / abort 两个 return 都带 justify，缺省 null', () => {
  const base = {
    pick: 'C01',
    idea: 'lib/gate.js 里有 36 行重复分支，可以删',
    why: '上个提交复制粘贴留下的',
    step1: { read: 'lib/gate.js:36-70', verdict: 'continue', abortIf: '没有重复分支就 abort' },
    step2: { change: '删掉重复分支', files: ['lib/gate.js'], estLines: 0, undo: 'git checkout -- lib/gate.js' },
    object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:36' },
    evidence: [{ claim: '第 36 行有重复', source: 'read', value: '36', at: '2026-11-10T05:28:00Z' }],
    plan: { steps: ['P1×files', 'P2×files'], files: ['lib/gate.js'], estLines: 0 },
    intent: { reversibility: 'auto', undo: { howto: 'git checkout -- lib/gate.js' } },
    justify: { gain: '36 行重复收到 12 行', surface: 'gate.js 少一层嵌套', fallback: 'git checkout -- lib/gate.js' },
  };
  const options = { candidates: [{ id: 'C01', objectKind: 'files' }] };
  const parsed = parseStage2Plan(JSON.stringify(base), options);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.plan.justify, base.justify);

  const aborted = parseStage2Plan(JSON.stringify({
    pick: 'C01',
    idea: '读下来不值得动',
    why: '这处已经修过了',
    step1: { read: 'lib/gate.js:36', verdict: 'abort', abortIf: '已经修过就 abort' },
    justify: base.justify,
  }), options);
  assert.equal(aborted.ok, true);
  assert.deepEqual(aborted.plan.justify, base.justify);

  const noJustify = { ...base };
  delete noJustify.justify;
  assert.equal(parseStage2Plan(JSON.stringify(noJustify), options).plan.justify, null);
  assert.equal(parseStage2Plan(JSON.stringify({ ...base, justify: '随便写一句' }), options).plan.justify, null);
});
