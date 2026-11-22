/**
 * solution 动机（取已定方案并落地）：注册表、取池、grid、GA18/GA19/GA20、goal 与提示词。
 *
 * 五件事分开钉：
 *   1. 动机表是唯一来源：八档、solution 的参数、grid 与 gate 共用一份单段读白名单；
 *   2. 取池只读、只认 `status='已定方案'`，库不在 / 读不了都回空数组且不抛；
 *   3. grid：solution 素材只挂 inspect×plan，池空时整条不进候选；
 *   4. gate：三道专属关（来源可核 / 执行面收敛 / 单步）正例放行、反例降级 ask；
 *   5. 开票 goal 与 stage2 提示词按池项拼，池外 id 不出现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  MOTIVATIONS,
  MOTIVATION_IDS,
  MOTIVATION_PRIMITIVES,
  MOTIVATION_WEIGHTS,
  SINGLE_READ_MOTIVATIONS,
  SOLUTION_BL_ID_RE,
  isSolutionMotivation,
  solutionPoolIds,
} from '../lib/motivations.js';
import { PROPOSER_MOTIVATIONS } from '../lib/proposer.js';
import { PRIMITIVES, OBJECT_KINDS, SINGLE_READ_MOTIVATIONS as GRID_SINGLE_READ, buildGrid, materialHintsOf } from '../lib/grid.js';
import {
  REWRITE_GATE_ACTIONS,
  STAGE2_MOTIVATION_RULES,
  checkStage2Plan,
} from '../lib/gate.js';
import { buildStage2Prompt, buildStage2RewritePrompt, renderSolutionPoolLines } from '../lib/proposer.js';
import { applySolutionGoal } from '../lib/engines/proposer.js';
import {
  buildSolutionGoal,
  createSolutionPoolProvider,
  findSolutionPlanFile,
  loadSolutionPool,
  resolveSolutionItem,
  solutionIdInPlan,
  solutionPlanFile,
} from '../lib/backlog-pool.js';

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const BL = 'bl-mf3k2a-9f2e';
const OTHER_BL = 'bl-mf3k2a-77aa';
const SOLUTION_MATERIAL = '从工单池取一条「已定方案」（backlog_list status=已定方案），读它的方案正文；能小范围、可自动撤回地落地就直接执行';

const PRIMITIVE_KEY = new Map(PRIMITIVES.map((one) => [one.id, one.key]));
const OBJECT_KEY = new Map(OBJECT_KINDS.map((one) => [one.id, one.key]));
const cell = (primitive, objectKind) => ({
  primitive,
  primitiveKey: PRIMITIVE_KEY.get(primitive) ?? primitive,
  objectKind,
  objectKey: OBJECT_KEY.get(objectKind) ?? objectKind,
});

/** 一对「读方案 → 改文件」的 solution 候选，形状与 buildGrid 的输出一致。 */
const solutionCandidate = (over = {}) => ({
  id: 'C01',
  read: cell('inspect', 'plan'),
  action: cell('edit-file', 'files'),
  material: SOLUTION_MATERIAL,
  motivation: 'solution',
  note: '读 读 × 计划大纲 → 动 改文件 × 文件｜有副作用 auto',
  score: 39,
  defaults: { impact: 'local-write', reversibility: 'auto' },
  ...over,
});

/** 一份能过 GA1~GA17 的 solution 方案；单测只覆盖想验的那一处分歧。 */
const solutionPlan = (over = {}) => ({
  pick: 'C01',
  step1: {
    read: `读了 plans/backlog-${BL}.md 的方案正文，第一步是删 lib/x.js 里的 3 行`,
    verdict: 'continue',
    abortIf: '方案里要重启或删数据就 abort',
  },
  step2: { change: '删掉 lib/x.js 里 3 行重复分支', files: ['lib/x.js'], estLines: 3, undo: 'git checkout -- lib/x.js' },
  idea: '按已定方案删掉 lib/x.js 里 3 行重复分支',
  why: '方案正文写的就是这 3 行，git 能撤回',
  object: { kind: 'files', value: BL, anchor: BL },
  evidence: [{ claim: '重复分支 3 行', source: 'read', value: '3', at: '2026-11-19T00:00:00Z' }],
  plan: { steps: ['P1×plan', 'P2×files'], files: ['lib/x.js'], estLines: 3 },
  intent: {
    impact: { paths: ['lib/x.js'], services: [], remotes: [] },
    reversibility: 'auto',
    dryRun: { ok: true, detail: `read plans/backlog-${BL}.md` },
    undo: { kind: '', ref: '', howto: 'git checkout -- lib/x.js' },
  },
  ...over,
});

const gAs = (list) => list.map((one) => one.ga);
const solutionHits = (verdict) => gAs(verdict.downgrade).filter((ga) => ['GA18', 'GA19', 'GA20'].includes(ga));

/* ── 一、动机注册表是唯一来源 ─────────────────────────────────────── */

test('注册表：八档动机，solution 权重 3 / 原语 inspect+edit-file+edit-config / 不许单段读', () => {
  assert.equal(MOTIVATIONS.length, 8);
  assert.deepEqual(MOTIVATION_IDS, ['backlog', 'hygiene', 'sync', 'social', 'memory', 'status', 'self', 'solution']);
  // proposer 的白名单就是注册表的 id 列表（不再各抄一份）
  assert.deepEqual(PROPOSER_MOTIVATIONS, MOTIVATION_IDS);
  assert.equal(MOTIVATION_WEIGHTS.solution, 3);
  assert.deepEqual(MOTIVATION_PRIMITIVES.solution, ['inspect', 'edit-file', 'edit-config']);
  assert.deepEqual(Object.keys(MOTIVATIONS.find((one) => one.id === 'solution')).includes('actionPrimitives'), true);
  assert.equal(SINGLE_READ_MOTIVATIONS.includes('solution'), false);
  // 老七档的权重 / 原语一项没变
  assert.deepEqual(
    ['backlog', 'hygiene', 'sync', 'social', 'memory', 'status', 'self'].map((id) => MOTIVATION_WEIGHTS[id]),
    [3, 1, 2, 2, 2, 3, 1],
  );
  assert.ok(isSolutionMotivation('solution'));
  assert.equal(isSolutionMotivation('backlog'), false);
  // bl-id 形状与 dsh-backlog 的 newId 对齐
  assert.ok(SOLUTION_BL_ID_RE.test(BL));
  assert.equal(SOLUTION_BL_ID_RE.test('bl-x'), false);
});

test('单段读白名单只有一份：grid 与 gate 用同一个数组，solution 不许出单段读', () => {
  assert.equal(GRID_SINGLE_READ, SINGLE_READ_MOTIVATIONS, 'grid 转出的就是注册表那一份（同一个引用）');
  assert.deepEqual([...SINGLE_READ_MOTIVATIONS].sort(), ['hygiene', 'status']);
  // gate 的 GA15 也认这一份：solution 的单段读候选被拦
  const single = solutionCandidate({ action: null, read: cell('inspect', 'plan') });
  const verdict = checkStage2Plan(solutionPlan({
    plan: { steps: ['P1×plan'], files: [], estLines: 0 },
    step2: null,
  }), { candidates: [single], solutionPool: [{ id: BL }] });
  const ga15 = verdict.downgrade.find((one) => one.ga === 'GA15');
  assert.ok(ga15, 'GA15 要拦 solution 的单段读');
  assert.match(ga15.why, /单段只许 hygiene \/ status/);
});

test('规则表：GA18/19/20 都在 REWRITE_GATE_ACTIONS 里，落点与表里声明一致', () => {
  assert.deepEqual(
    STAGE2_MOTIVATION_RULES.map((one) => one.ga),
    ['GA18', 'GA19', 'GA20'],
  );
  for (const rule of STAGE2_MOTIVATION_RULES) {
    assert.deepEqual(rule.motivations, ['solution'], `${rule.ga} 只对 solution 生效`);
    assert.equal(REWRITE_GATE_ACTIONS[rule.ga], rule.action, `${rule.ga} 的 originalAction 要与表一致`);
    assert.equal(typeof rule.check, 'function');
  }
});

/* ── 二、取池：只读、只认已定方案、失败回空池 ─────────────────────── */

const BACKLOG_SCHEMA = `CREATE TABLE backlog (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  ticket_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** 建一个临时 backlog 库：两条已定方案 + 一条待办。 */
function makeBacklogDb(dir) {
  const file = path.join(dir, 'backlog.db');
  const db = new DatabaseSync(file);
  db.exec(BACKLOG_SCHEMA);
  const insert = db.prepare(
    `INSERT INTO backlog (id, title, status, note, ticket_ids, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?)`,
  );
  insert.run(BL, '把 x.js 的重复分支删掉', '已定方案', '方案正文：第一步删 3 行', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z');
  insert.run(OTHER_BL, '把 y.js 的日志级别改掉', '已定方案', '方案正文：改一行', '2026-11-18T01:00:00Z', '2026-11-19T00:00:00Z');
  insert.run('bl-mf3k2a-0001', '还在调研的事', '待办', '', '2026-11-19T01:00:00Z', '2026-11-19T01:00:00Z');
  db.close();
  return file;
}

test('取池：只 SELECT 已定方案，按 updated_at 升序，读不到不抛也不建库', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-solution-'));
  try {
    const file = makeBacklogDb(dir);
    const plansDir = path.join(dir, 'plans');
    const pool = await loadSolutionPool({ file, plansDir });
    assert.deepEqual(pool.map((one) => one.id), [BL, OTHER_BL], '待办不进池，顺序按 updated_at');
    assert.equal(pool[0].planFile, path.join(plansDir, `backlog-${BL}.md`));
    assert.equal(pool[0].hasPlanFile, false, '方案文件还没落盘');
    // 落一份方案文件后 hasPlanFile 翻真
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(pool[0].planFile, '# 方案\n');
    const again = await loadSolutionPool({ file, plansDir });
    assert.equal(again[0].hasPlanFile, true);

    const lines = [];
    const missing = path.join(dir, 'nope.db');
    const empty = await loadSolutionPool({ file: missing, log: (line) => lines.push(line) });
    assert.deepEqual(empty, []);
    assert.equal(fs.existsSync(missing), false, 'readOnly 不建库');
    assert.ok(lines.some((line) => line.startsWith('solution_pool_fail:')), '失败只记日志');

    // provider 再兜一层：传一个目录当库也不许抛
    const provider = createSolutionPoolProvider({ file: dir, log: (line) => lines.push(line) });
    assert.deepEqual(await provider(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('短号命中全号方案文档：backlog-bl-*-<短号>.md，别的短号不许误命中', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-solution-suffix-'));
  try {
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    const file = makeBacklogDb(dir);
    // 库里那条只剩 4 位短号（2026-11-22 日志里的 b40e 就是这样），真名落盘是全号
    const db = new DatabaseSync(file);
    db.prepare('DELETE FROM backlog WHERE id = ?').run(BL);
    db.prepare('DELETE FROM backlog WHERE id = ?').run(OTHER_BL);
    db.prepare(
      `INSERT INTO backlog (id, title, status, note, ticket_ids, created_at, updated_at)
       VALUES ('b40e', '探路 declare 后执行轮不自动续派', '已定方案', 'note 里只有摘要', '[]', ?, ?)`,
    ).run('2026-11-22T00:00:00Z', '2026-11-22T00:00:00Z');
    db.close();

    // 同前缀、不同短号的文档：短号 b40e 不许拿它顶
    fs.writeFileSync(path.join(plansDir, 'backlog-bl-mwn2jrdm-b40f.md'), '# 别的工单\n');
    assert.equal(findSolutionPlanFile('b40e', { plansDir }), '', '短号必须整段相等，b40f 不算命中');

    // 改前口径：只认精确名 backlog-b40e.md，全号文档存在也判「没有文档」
    const before = await loadSolutionPool({ file, plansDir });
    assert.equal(before[0].hasPlanFile, false);
    assert.equal(before[0].planFile, path.join(plansDir, 'backlog-b40e.md'));
    const beforeLines = renderSolutionPoolLines(before);
    assert.ok(beforeLines.some((line) => line.includes('note：')), '没有文档时提示词只给 note，模型就会去重写一份');

    // 全号文档落盘后：hasPlanFile 翻真，池行给的是盘上真实路径
    fs.writeFileSync(path.join(plansDir, 'backlog-bl-mwn2jrdm-b40e.md'), '# 全号方案\n');
    const after = await loadSolutionPool({ file, plansDir });
    assert.equal(after[0].hasPlanFile, true);
    assert.equal(after[0].planFile, path.join(plansDir, 'backlog-bl-mwn2jrdm-b40e.md'));
    const afterLines = renderSolutionPoolLines(after);
    assert.ok(afterLines.some((line) => line.includes('方案文件') && line.includes('backlog-bl-mwn2jrdm-b40e.md')));
    assert.equal(afterLines.some((line) => line.includes('note：')), false, '有文档就不许再退化成 note 摘要');

    // 全号 id 照旧能命中全号文档；目录不在不抛
    assert.equal(findSolutionPlanFile('bl-mwn2jrdm-b40e', { plansDir }), path.join(plansDir, 'backlog-bl-mwn2jrdm-b40e.md'));
    assert.equal(findSolutionPlanFile('b40e', { plansDir: path.join(dir, 'nope') }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 三、grid：solution 素材只挂 plan，池空整条不进候选 ───────────── */
test('grid：solution 素材命中 plan 不命中 ticket；池非空出「读方案 → 改文件」候选', () => {
  const hints = materialHintsOf(SOLUTION_MATERIAL, 'solution');
  assert.ok(hints.objects.has('plan'), '「已定方案 / 方案正文」→ plan');
  assert.equal(hints.objects.has('ticket'), false, 'solution 不挂 ticket：挂了会配不出动作格');
  assert.equal(hints.primitives.size, 0);

  const materials = [{ text: SOLUTION_MATERIAL, motivation: 'solution' }];
  // 故意把 draft / service / delete 全打开：solution 必须在 stage1 就把动作面收敛掉，
  // 不能等 GA19 在 gate 里拦（否则每拍白烧一次重写）
  const primitives = { inspect: true, editFile: true, editConfig: true, draft: true, service: true, delete: true };
  const objects = { plan: true, files: true, config: true, service: true, ticket: true };
  const withPool = buildGrid({ materials, primitives, objects, solutionPool: [{ id: BL }] });
  assert.ok(withPool.length > 0, '池里有方案就出候选');
  assert.ok(withPool.every((one) => one.read.objectKind === 'plan'), 'solution 的读格只能是 plan');
  assert.ok(
    withPool.every((one) => one.action && ['edit-file', 'edit-config'].includes(one.action.primitive)),
    '动作格只能是改文件 / 改配置',
  );
  assert.equal(withPool.some((one) => one.action?.primitive === 'draft'), false, 'draft×plan 同对象加成也进不来');

  const noPool = buildGrid({ materials, primitives, objects, solutionPool: [] });
  assert.deepEqual(noPool, [], '池空时 solution 素材整条不进候选');
});

/* ── 四、gate：GA18 来源可核 ──────────────────────────────────────── */

test('GA18：bl-id 在本拍池里放行；池外 / 没写都是降级 ask', () => {
  const ok = checkStage2Plan(solutionPlan(), { candidates: [solutionCandidate()], solutionPool: [{ id: BL }] });
  assert.deepEqual(solutionHits(ok), [], '来源可核，三道都不响');
  assert.ok(ok.notes.some((line) => line.includes('bl-id')), 'bl-id 不按路径查存在性，要留一条 note');

  const outside = checkStage2Plan(solutionPlan(), {
    candidates: [solutionCandidate()],
    solutionPool: [{ id: OTHER_BL }],
  });
  const ga18 = outside.downgrade.find((one) => one.ga === 'GA18');
  assert.ok(ga18, '池外 id 要降级');
  assert.equal(ga18.originalAction, 'ask');
  assert.match(ga18.why, new RegExp(`${BL}.*不在本拍已定方案池里`));

  const noId = checkStage2Plan(solutionPlan({
    object: { kind: 'files', value: 'lib/x.js', anchor: 'lib/x.js:1' },
    step1: { read: '读了 lib/x.js', verdict: 'continue', abortIf: '读不到就 abort' },
    plan: { steps: ['P1×plan', 'P2×files'], files: ['lib/x.js'], estLines: 3 },
  }), { candidates: [solutionCandidate()], solutionPool: [{ id: BL }] });
  assert.match(noId.downgrade.find((one) => one.ga === 'GA18').why, /没写出已定方案的 bl-id/);
});

/* ── 五、gate：GA19 执行面收敛 ───────────────────────────────────── */

test('GA19：改文件 / 改配置放行；动服务、删、停服字样都降级 ask', () => {
  const configCandidate = solutionCandidate({ action: cell('edit-config', 'config') });
  const ok = checkStage2Plan(solutionPlan({
    object: { kind: 'config', value: BL, anchor: BL },
    step2: { change: '改 ~/.dsh-ego/config.yml 的一个键', files: ['/home/julia/.dsh-ego/config.yml'], estLines: 1, undo: 'git checkout -- config.yml' },
    plan: { steps: ['P1×plan', 'P3×config'], files: ['/home/julia/.dsh-ego/config.yml'], estLines: 1 },
    intent: {
      impact: { paths: ['/home/julia/.dsh-ego/config.yml'], services: [], remotes: [] },
      reversibility: 'manual',
      dryRun: { ok: true, detail: 'read config.yml' },
      undo: { kind: '', ref: '', howto: 'cp config.yml.bak config.yml' },
    },
  }), { candidates: [configCandidate], solutionPool: [{ id: BL }] });
  assert.deepEqual(solutionHits(ok), [], '改配置是允许的执行面');

  const badPrimitive = checkStage2Plan(solutionPlan({
    plan: { steps: ['P1×plan', 'P6×files'], files: ['lib/x.js'], estLines: 3 },
  }), { candidates: [solutionCandidate()], solutionPool: [{ id: BL }] });
  const ga19a = badPrimitive.downgrade.find((one) => one.ga === 'GA19');
  assert.ok(ga19a, 'delete 步骤要降级');
  assert.equal(ga19a.originalAction, 'ask');
  assert.match(ga19a.why, /只许改文件 \/ 改配置/);

  const badText = checkStage2Plan(solutionPlan({
    step2: { change: '改完 lib/x.js 后 systemctl restart dsh-ego', files: ['lib/x.js'], estLines: 3, undo: 'git checkout -- lib/x.js' },
  }), { candidates: [solutionCandidate()], solutionPool: [{ id: BL }] });
  const ga19b = badText.downgrade.find((one) => one.ga === 'GA19');
  assert.ok(ga19b, '方案文本里的 reboot/stop 字样要降级');
  assert.match(ga19b.why, /systemctl/);
});

/* ── 六、gate：GA20 单步 ─────────────────────────────────────────── */

test('GA20：读一步 + 动一步放行；两步动作降级 ask', () => {
  const oneStep = checkStage2Plan(solutionPlan(), { candidates: [solutionCandidate()], solutionPool: [{ id: BL }] });
  assert.equal(solutionHits(oneStep).includes('GA20'), false);

  const twoSteps = checkStage2Plan(solutionPlan({
    plan: { steps: ['P1×plan', 'P2×files', 'P3×config'], files: ['lib/x.js', 'config.yml'], estLines: 4 },
  }), { candidates: [solutionCandidate()], solutionPool: [{ id: BL }] });
  const ga20 = twoSteps.downgrade.find((one) => one.ga === 'GA20');
  assert.ok(ga20, '两步动作要降级');
  assert.equal(ga20.originalAction, 'ask');
  assert.match(ga20.why, /只做方案的第一步/);
});

test('GA18/19/20 只对 solution 生效：同一份方案换回 backlog 动机一道都不响', () => {
  const candidate = solutionCandidate({ motivation: 'backlog' });
  const verdict = checkStage2Plan(solutionPlan({
    object: { kind: 'files', value: BL, anchor: BL },
    plan: { steps: ['P1×plan', 'P2×files', 'P3×config'], files: ['lib/x.js'], estLines: 4 },
  }), { candidates: [candidate], solutionPool: [] });
  assert.deepEqual(solutionHits(verdict), []);
});

/* ── 七、goal 与提示词 ───────────────────────────────────────────── */

test('goal：按池项拼「执行已定方案 <bl-id>」，有方案文件写路径、没有写 note 摘要', () => {
  const withFile = buildSolutionGoal({
    id: BL,
    title: '把 x.js 的重复分支删掉',
    note: '方案正文',
    planFile: `/srv/fatfish/plans/backlog-${BL}.md`,
    hasPlanFile: true,
  }, solutionPlan());
  assert.match(withFile, new RegExp(`^执行已定方案 ${BL}：`));
  assert.match(withFile, new RegExp(`方案文件 /srv/fatfish/plans/backlog-${BL}\\.md`));
  assert.match(withFile, /只做第一步：删掉 lib\/x\.js 里 3 行重复分支/);
  assert.match(withFile, /完成后把该条目改已完成。$/);

  const noFile = buildSolutionGoal({ id: BL, title: '标题', note: '正文里写了先改 x.js', hasPlanFile: false }, solutionPlan());
  assert.match(noFile, /方案摘要：正文里写了先改 x\.js/);
  assert.equal(buildSolutionGoal({ id: '' }, solutionPlan()), '', '没有 id 拼不出 goal');

  assert.deepEqual(solutionIdInPlan(solutionPlan()), { id: BL, field: 'object.value' });
  assert.equal(solutionIdInPlan(solutionPlan({ object: { kind: 'files', value: 'lib/x.js', anchor: 'x:1' }, step1: { read: `读 plans/backlog-${BL}.md`, verdict: 'continue', abortIf: 'x' }, plan: { steps: [], files: [] } }))?.field, 'step1.read');
  assert.equal(resolveSolutionItem(solutionPlan(), [{ id: BL, title: 't' }]).id, BL);
  assert.equal(resolveSolutionItem(solutionPlan(), [{ id: OTHER_BL }]), null);
  assert.equal(solutionPlanFile(BL, { plansDir: '/srv/plans' }), path.join('/srv/plans', `backlog-${BL}.md`));
});

test('开票 goal 接线：do + solution 才覆盖 ticket.goal，brief 不动、别的动机不动', () => {
  const pool = [{ id: BL, title: '删 x.js 重复分支', note: '正文', planFile: `/p/backlog-${BL}.md`, hasPlanFile: true }];
  const decision = {
    action: 'do',
    text: '',
    ticket: { goal: '终审写的 goal', brief: '票面一句话', intent: { reversibility: 'auto' } },
    reason: '小改',
  };
  const lines = [];
  const patched = applySolutionGoal(decision, solutionPlan(), solutionCandidate(), pool, { log: (line) => lines.push(line) });
  assert.notEqual(patched, decision, '要出新对象，别原地改终审裁决');
  assert.match(patched.ticket.goal, new RegExp(`^执行已定方案 ${BL}：`));
  assert.equal(patched.ticket.brief, '票面一句话', 'brief 不动，仍由 route.js 按 34 列截断');
  assert.deepEqual(patched.ticket.intent, decision.ticket.intent, 'intent 原样保留');
  assert.ok(lines.some((line) => line.startsWith(`solution_goal:${BL}`)));

  assert.equal(applySolutionGoal(decision, solutionPlan(), solutionCandidate({ motivation: 'hygiene' }), pool), decision);
  assert.equal(applySolutionGoal({ ...decision, action: 'ask', ticket: null }, solutionPlan(), solutionCandidate(), pool).action, 'ask');
  // 池项对不上（GA18 正常会拦，这里兜底）：保留终审原 goal
  const skipped = applySolutionGoal(decision, solutionPlan(), solutionCandidate(), [{ id: OTHER_BL }], { log: (line) => lines.push(line) });
  assert.equal(skipped, decision);
  assert.ok(lines.some((line) => line.startsWith('solution_goal_skip:')));
});

test('提示词：solution 模式带本拍池与四条规矩，别的动机不带', () => {
  const pool = [{ id: BL, title: '删 x.js 重复分支', note: '正文', planFile: `/p/backlog-${BL}.md`, hasPlanFile: true }];
  const prompt = buildStage2Prompt([solutionCandidate()], [{ text: SOLUTION_MATERIAL, motivation: 'solution' }], { solutionPool: pool });
  assert.match(prompt, /本拍已定方案池（1 条/);
  assert.match(prompt, new RegExp(BL));
  assert.match(prompt, /只做这条方案的第一步/);
  assert.match(prompt, /step1\.verdict=abort/);
  assert.match(prompt, /evidence\.source 只许写这一拍真调过的工具名/);

  const plain = buildStage2Prompt([solutionCandidate({ motivation: 'hygiene' })], [], { solutionPool: pool });
  assert.equal(plain.includes('本拍已定方案池'), false);
  assert.equal(plain.includes('只做这条方案的第一步'), false);

  const rewrite = buildStage2RewritePrompt({
    ga: 'GA20',
    reason: '多步了',
    idea: '按方案删 3 行',
    plan: solutionPlan(),
    candidates: [solutionCandidate()],
    solutionPool: pool,
  });
  assert.match(rewrite, /本拍已定方案池/);
  assert.match(rewrite, /只做这条方案的第一步/);
  const plainRewrite = buildStage2RewritePrompt({ ga: 'GA6', reason: 'x', plan: solutionPlan(), candidates: [solutionCandidate({ motivation: 'hygiene' })] });
  assert.equal(plainRewrite.includes('本拍已定方案池'), false);
});

test('接线源码：一拍取一次池，传进 buildGrid / gate / 提示词 / goal 重拼', () => {
  const source = fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8');
  assert.match(source, /const solutionPool = await solutionPoolOfRound\(\)/, 'buildGrid 之前取一次池');
  assert.match(source, /materials: section\.materials,[\s\S]{0,200}solutionPool,/, '池传给 buildGrid');
  assert.match(source, /solutionPool,\n\s+\}\)/, '池传给 gate.checkPlan');
  assert.match(source, /buildStage2Prompt\(\[candidate\], section\.materials, \{ now: new Date\(nowMs\), state, solutionPool \}\)/);
  assert.match(source, /applySolutionGoal\(outcome\.decision, finalPlan, candidate, solutionPool, \{ log \}\)/);
  // 取池失败不许抛：provider 外层还有 try/catch，池一定是数组
  assert.match(source, /Array\.isArray\(pool\) \? pool\.filter/, 'provider 给的不是数组也收成空池');
});

test('池 id 归一：字符串与 {id} 都认，重复去掉，坏项丢掉', () => {
  assert.deepEqual(solutionPoolIds([BL, { id: OTHER_BL }, { id: BL }, null, {}, '']).sort(), [BL, OTHER_BL].sort());
});
