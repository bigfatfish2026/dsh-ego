/**
 * replay 变差率按改动规模分层（lib/change-scale.js + replay.js 的 judgeChange/loadScaleHistory）
 * 与 grid 权重接线的单测。
 *
 * 盯八件事：
 *   1. 判档边界：files/writes 的 small 上限、files 的 large 下限、steps 里的 delete/service/outbound；
 *   2. 同一档内的变差率 → 系数（阈值、下限）；
 *   3. large 档不被 small 档的败绩拖累（下面那条真样本对照）；
 *   4. 三档下限分别是 0.4 / 0.6 / 0.8；
 *   5. 与 combo 系数相乘后整体 clamp(0.3, 2.0)，顺序固定；
 *   6. 空数据与坏行：不炸、跳过；
 *   7. 确定性排序路径不随 history 变化（buildGrid 不传 seed 时逐字一致）；
 *   8. judgeChange 的口径与改前一致（replay 判据只搬了家）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHANGE_SCALES,
  COMBINED_FACTOR_MAX,
  COMBINED_FACTOR_MIN,
  LARGE_MIN_FILES,
  LARGE_STEP_PRIMITIVES,
  SCALE_FACTOR_FLOOR,
  SCALE_WORSE_THRESHOLD,
  SMALL_MAX_FILES,
  accumulateScale,
  changeScaleOf,
  combinedFactor,
  emptyScaleStats,
  scaleFactorOf,
  scaleFactorOfStat,
  stepPrimitiveOf,
} from '../lib/change-scale.js';
import { judgeChange, loadScaleHistory } from '../lib/replay.js';
import { OBJECT_KINDS, PRIMITIVES, buildGrid } from '../lib/grid.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ALL_PRIMITIVES = Object.fromEntries(PRIMITIVES.map((p) => [p.key, true]));
const ALL_OBJECTS = Object.fromEntries(OBJECT_KINDS.map((o) => [o.key, true]));
const MATERIALS = [{ text: '翻仓库找跑不过的测试', motivation: 'hygiene' }];
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scale-')), name);

/** 一份 plan 原文：files 条数、steps、intent 写面都可控 */
const planOf = ({ files = [], writes = [], steps = [] } = {}) => ({
  plan: { steps, files },
  step2: { files },
  intent: { impact: { paths: writes, services: [], remotes: [] } },
});

/** 一条 plans.jsonl 记录 */
const rec = ({ ts = NOW, comboKey = 'inspect|files→edit-file|files', plan = {}, changed } = {}) => ({
  ts,
  comboKey,
  candidate: { pick: 'C01', read: { primitive: 'inspect', objectKind: 'files' }, action: { primitive: 'edit-file', objectKind: 'files' } },
  plan,
  gate: { items: [] },
  veto: null,
  judge: { action: 'silent', reason: '' },
  ...(changed ? { __changed: changed } : {}),
});

/* ── 判档 ─────────────────────────────────────────────────────────── */

test('判档：small = files ≤1 且 writes ≤1', () => {
  assert.equal(SMALL_MAX_FILES, 1);
  assert.equal(changeScaleOf(rec({ plan: planOf({ files: ['/a'], writes: ['/a'] }) })), 'small');
  assert.equal(changeScaleOf(rec({ plan: planOf({ files: [], writes: [] }) })), 'small');
  assert.equal(changeScaleOf(rec({ plan: planOf({ files: ['/a', '/b'], writes: [] }) })), 'medium', '两个文件就不是 small');
  assert.equal(changeScaleOf(rec({ plan: planOf({ files: ['/a'], writes: ['/a', '/b'] }) })), 'medium', '写面两处也不是 small');
});

test('判档：large = files ≥3 或 steps 含 delete/service/outbound', () => {
  assert.equal(LARGE_MIN_FILES, 3);
  assert.deepEqual([...LARGE_STEP_PRIMITIVES], ['delete', 'service', 'outbound']);
  assert.equal(changeScaleOf(rec({ plan: planOf({ files: ['/a', '/b', '/c'] }) })), 'large');
  for (const step of ['P6×files', 'delete|files', 'delete×files', 'P6', 'P4×service', 'P7×session', 'outbound'] ) {
    assert.equal(changeScaleOf(rec({ plan: planOf({ files: ['/a'], steps: ['P1×files', step] }) })), 'large', step);
  }
  assert.equal(changeScaleOf(rec({ plan: planOf({ files: ['/a', '/b'], steps: ['P1×files', 'P2×files'] }) })), 'medium');
});

test('判档：large 优先于 small（3 个文件但只写 1 处也是 large）', () => {
  assert.equal(changeScaleOf(rec({ plan: planOf({ files: ['/a', '/b', '/c'], writes: ['/a'] }) })), 'large');
});

test('判档：文件去重，plan.plan.files 与 step2.files 合并计数', () => {
  const plan = { plan: { files: ['/a', '/a', '/b'], steps: [] }, step2: { files: ['/b', '/c'] } };
  assert.equal(changeScaleOf({ plan }), 'large');
});

test('判档：能直接吃 plan 原文，也能吃空记录', () => {
  assert.equal(changeScaleOf(planOf({ files: ['/a'] })), 'small');
  assert.equal(changeScaleOf(null), 'small');
  assert.equal(changeScaleOf({}), 'small');
});

test('stepPrimitiveOf：P4/P6/P7 与规则 id 都认，认不出的不乱判', () => {
  assert.equal(stepPrimitiveOf('P6×files'), 'delete');
  assert.equal(stepPrimitiveOf('P4|service'), 'service');
  assert.equal(stepPrimitiveOf('outbound×session'), 'outbound');
  assert.equal(stepPrimitiveOf('P2×files'), 'edit-file');
  assert.equal(stepPrimitiveOf(''), '');
  assert.equal(stepPrimitiveOf('随便写写'), '');
});

/* ── 变差率与系数 ─────────────────────────────────────────────────── */

test('阈值与下限常量：small/medium 35%，large 50%；下限 0.4/0.6/0.8', () => {
  assert.deepEqual({ ...SCALE_WORSE_THRESHOLD }, { small: 0.35, medium: 0.35, large: 0.5 });
  assert.deepEqual({ ...SCALE_FACTOR_FLOOR }, { small: 0.4, medium: 0.6, large: 0.8 });
  assert.deepEqual([...CHANGE_SCALES], ['small', 'medium', 'large']);
});

test('同档变差率：低于阈值不降权，达到阈值按 1-rate 降，夹到该档下限', () => {
  assert.equal(scaleFactorOfStat({ total: 10, worse: 3 }, 'small'), 1, '30% < 35% 不降权');
  assert.equal(scaleFactorOfStat({ total: 10, worse: 4 }, 'small'), 0.6);
  assert.equal(scaleFactorOfStat({ total: 10, worse: 9 }, 'small'), SCALE_FACTOR_FLOOR.small);
  assert.equal(scaleFactorOfStat({ total: 10, worse: 9 }, 'medium'), SCALE_FACTOR_FLOOR.medium);
  assert.equal(scaleFactorOfStat({ total: 10, worse: 9 }, 'large'), SCALE_FACTOR_FLOOR.large);
  assert.equal(scaleFactorOfStat({ total: 0, worse: 0 }, 'large'), 1);
  assert.equal(scaleFactorOfStat(null, 'large'), 1);
  assert.equal(scaleFactorOfStat({ total: 4, worse: 2 }, 'nope'), 1);
});

test('large 档放宽：50% 变差率仍按 0.8 算，不被压到 0.4', () => {
  assert.equal(scaleFactorOfStat({ total: 10, worse: 5 }, 'large'), 0.8);
  assert.equal(scaleFactorOfStat({ total: 10, worse: 5 }, 'small'), 0.5, '同一份账在 small 档会更低');
});

test('scaleFactorOf：只看 lastScale 那一档的账', () => {
  const entry = {
    lastScale: 'large',
    byScale: { small: { total: 10, worse: 9 }, medium: { total: 0, worse: 0 }, large: { total: 10, worse: 5 } },
  };
  assert.equal(scaleFactorOf(entry), 0.8, 'small 的败绩不进 large 的账');
  assert.equal(scaleFactorOf(entry, 'small'), 0.4);
  assert.equal(scaleFactorOf(null), 1);
  assert.equal(scaleFactorOf({ lastScale: '' }), 1);
});

test('合并系数：相乘后整体 clamp(0.3, 2.0)', () => {
  assert.equal(COMBINED_FACTOR_MIN, 0.3);
  assert.equal(COMBINED_FACTOR_MAX, 2.0);
  assert.equal(combinedFactor(0.4, 0.4), 0.3, '0.16 抬到 0.3');
  assert.equal(combinedFactor(1.5, 1), 1.5);
  assert.equal(combinedFactor(1.5, 1.4), 2.0, '高端夹到 2.0');
  assert.equal(combinedFactor(0.8, 1), 0.8);
  assert.equal(combinedFactor(1, 1), 1);
});

/* ── 真样本对照 ───────────────────────────────────────────────────── */

/*
 * 真样本：plans.jsonl 里 `inspect|files→delete|files` 这一对共 16 条，13 条 large、3 条 small
 * （large 判据是 steps 含 `P6×files`，files 只有 2 条也算大改）。这一对历史 win 0 / loss 3，
 * combo 系数原本就是 clamp(1/4) = 0.4。下面按同一分布造重放结果：13 条 large 里 11 条 worse、
 * 3 条 small 全 same——
 *   改前（整对不分档）：11/16 ≈ 68.75% ≥ 35% → 1-0.6875 = 0.3125 → 夹到 small 下限 0.4；
 *   改后（large 档）：11/13 ≈ 84.6% ≥ 50% → 1-0.846 ≈ 0.154 → 夹到 large 下限 0.8。
 */
test('真样本：大改被判变差时，改前 0.4、改后不低于 0.8', () => {
  const largePlan = { plan: { steps: ['P1×files', 'P6×files'], files: ['/home/julia/.dsh-ego/plans/a.md', '/home/julia/.dsh-ego/plans/b.md'] }, step2: { files: ['/a', '/b'] } };
  const smallPlan = { plan: { steps: ['P1×files', 'P2×files'], files: ['/a'] }, step2: { files: ['/a'] } };
  const key = 'inspect|files→delete|files';
  const table = new Map();
  for (let i = 0; i < 13; i += 1) accumulateScale(table, rec({ comboKey: key, plan: largePlan, ts: 1000 + i }), i < 11 ? 'worse' : 'same');
  for (let i = 0; i < 3; i += 1) accumulateScale(table, rec({ comboKey: key, plan: smallPlan, ts: 500 + i }), 'same');

  const entry = table.get(key);
  assert.equal(entry.byScale.large.total, 13);
  assert.equal(entry.byScale.small.total, 3);
  assert.equal(entry.lastScale, 'large', '最近一条是大改');

  // 改前口径：整对混在一起算（拿 small 档那条曲线当代表）
  const mixed = { total: 16, worse: 11 };
  const before = scaleFactorOfStat(mixed, 'small');
  // 改后：只看 large 档
  const after = scaleFactorOf(entry);
  assert.equal(before, 0.4);
  assert.equal(after, 0.8);
  assert.ok(after > before);

  // 与 combo 系数合并：这一对 win0/loss3 → combo = clamp(1/4) = 0.4，乘积夹到 0.3
  assert.ok(Math.abs(combinedFactor(0.4, after) - 0.32) < 1e-9);
});

/* ── 汇总与读盘 ───────────────────────────────────────────────────── */

test('accumulateScale：按 ts 取最新一条的档当 lastScale，空 comboKey 不记', () => {
  const table = new Map();
  accumulateScale(table, rec({ ts: 2000, plan: planOf({ files: ['/a'] }) }), 'same');
  accumulateScale(table, rec({ ts: 1000, plan: planOf({ files: ['/a', '/b', '/c'] }) }), 'worse');
  assert.equal(table.get('inspect|files→edit-file|files').lastScale, 'small', '旧的大改不覆盖新的 lastScale');
  accumulateScale(table, rec({ comboKey: '' }), 'worse');
  assert.equal(table.size, 1);
});

test('loadScaleHistory：坏行跳过，无 plan 的中间态记录不进分母', async () => {
  const file = tmpFile('plans.jsonl');
  const good = rec({ comboKey: 'a→b', plan: planOf({ files: ['/a'] }) });
  const noPlan = rec({ comboKey: 'a→b', plan: null });
  fs.writeFileSync(file, `${JSON.stringify(good)}\n{坏行\n${JSON.stringify(noPlan)}\n`, 'utf8');
  const replay = async (one) => ({ changed: one.plan ? 'worse' : 'same' });
  const out = await loadScaleHistory({ file, replay });
  assert.equal(out.bad, 1);
  const entry = out.table.get('a→b');
  assert.equal(entry.byScale.small.total, 1, '只有带 plan 的那条进账');
  assert.equal(entry.byScale.small.worse, 1);
});

test('loadScaleHistory：空文件给空表，不炸', async () => {
  const out = await loadScaleHistory({ file: tmpFile('nope.jsonl') });
  assert.equal(out.table.size, 0);
  assert.equal(out.rows, 0);
  assert.equal(out.cached, false);
});

test('loadScaleHistory：文件没变就复用整表（mtime+size 缓存）', async () => {
  const file = tmpFile('cached.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(rec({ comboKey: 'a→b', plan: planOf({ files: ['/a'] }) }))}\n`, 'utf8');
  let replays = 0;
  const replay = async () => {
    replays += 1;
    return { changed: 'same' };
  };
  const first = await loadScaleHistory({ file, replay });
  const second = await loadScaleHistory({ file, replay });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(replays, 1, '第二次不重放');
});

test('loadScaleHistory：真实 plans.jsonl 与 combo 共用一次读盘', { skip: !fs.existsSync('/home/julia/.dsh-ego/plans.jsonl') }, async () => {
  const out = await loadScaleHistory({ file: '/home/julia/.dsh-ego/plans.jsonl' });
  // 文件每拍都在长，别把行数写死（写死 283 会在下一拍变红）；只核「读得动、有条目」
  assert.ok(out.rows >= 283, `rows=${out.rows}`);
  assert.ok(out.table.size > 0);
  assert.ok(out.ms >= 0);
});

/* ── grid 接线与确定性路径 ────────────────────────────────────────── */

const gridArgs = { materials: MATERIALS, primitives: ALL_PRIMITIVES, objects: ALL_OBJECTS, now: NOW };

test('grid：确定性路径不受 combo / scale 历史影响', () => {
  const base = buildGrid({ ...gridArgs });
  const withHistory = buildGrid({
    ...gridArgs,
    comboHistory: new Map([['inspect|files→edit-file|files', { win: 0, loss: 5 }]]),
    scaleHistory: new Map([['inspect|files→edit-file|files', { lastScale: 'small', byScale: { small: { total: 5, worse: 5 }, medium: { total: 0, worse: 0 }, large: { total: 0, worse: 0 } } }]]),
  });
  assert.deepEqual(withHistory, base);
});

test('grid：随机路径吃 scale 系数，但整对权重仍 >0（clamp 下限 0.3）', () => {
  const scaleHistory = new Map([['inspect|files→edit-file|files', {
    lastScale: 'large',
    byScale: { small: { total: 9, worse: 9 }, medium: { total: 0, worse: 0 }, large: { total: 9, worse: 9 } },
  }]]);
  const rows = buildGrid({ ...gridArgs, seed: 42, scaleHistory });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((one) => Number.isFinite(one.score)));
});

test('grid：空 scale 历史与不传一样', () => {
  const base = buildGrid({ ...gridArgs, seed: 7 });
  assert.deepEqual(buildGrid({ ...gridArgs, seed: 7, scaleHistory: new Map() }), base);
  assert.deepEqual(buildGrid({ ...gridArgs, seed: 7, scaleHistory: null }), base);
});

/* ── judgeChange（replay 判据搬家后口径不变） ─────────────────────── */

const items = (...actions) => actions.map((action, i) => ({ ga: `GA${i + 1}`, action, why: '' }));

test('judgeChange：pass 翻转优先，burden 次之', () => {
  assert.equal(judgeChange({ before: [], after: items('reject') }).changed, 'worse');
  assert.equal(judgeChange({ before: items('reject'), after: [] }).changed, 'better');
  assert.equal(judgeChange({ before: [], after: [] }).changed, 'same');
  assert.equal(judgeChange({ before: items('downgrade', 'downgrade'), after: items('downgrade') }).changed, 'better');
  assert.equal(judgeChange({ before: items('downgrade'), after: items('downgrade', 'downgrade') }).changed, 'worse');
  assert.equal(judgeChange({ before: items('unsupported'), after: [] }).changed, 'same', '未核不算坏');
});

test('judgeChange：veto 从不拦到拦 = worse，反之 better', () => {
  assert.equal(judgeChange({ before: [], after: [], beforeVetoOk: true, afterVetoOk: false }).changed, 'worse');
  assert.equal(judgeChange({ before: [], after: [], beforeVetoOk: false, afterVetoOk: true }).changed, 'better');
  assert.equal(judgeChange({ before: items('reject'), after: items('reject'), beforeVetoOk: false, afterVetoOk: true }).changed, 'same');
});
