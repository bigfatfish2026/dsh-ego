/**
 * 两阶段第 4 批：gate 的 GA1~GA16（规则第七节整张表 + 第九节新增的两条）。
 *
 * 盯六件事：
 *   1. 纯函数 checkStage2Plan 只做能机核的规则，不碰 fs；GA3/GA4/GA5 的读盘那半
 *      走 createGate({deps}) 注入，单测传 stub；
 *   2. 每条 GA 都有正例与反例，失败文案是人话（带 GA 编号只是索引，不是错误码）；
 *   3. GA6 只拦「比候选默认更宽松」，更保守的写法一律放行；service 的 stop/disable
 *      按实例压到 none（规则 83/417 行），restart/start/enable 不受影响；
 *   4. GA11 按候选的原语/对象判，不看 evidence.source（模型漏写就绕过的坑）；
 *   5. GA14 按 outboundTargets 白名单判 outbound 目标，空表 = 一律不许发；
 *   6. GA15/GA16 管两段式结构：候选是一对（读格 R → 动作格 A），方案得写 step1/step2，
 *      且第一步那个原语必须是只读的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkStage2Plan, createGate, IMPACT_SLOTS, REVERSIBILITY_RANK, FILE_LINE_PATTERN } from '../lib/gate.js';
import { PAIR_SET, PRIMITIVES, OBJECT_KINDS } from '../lib/grid.js';
import { checkExists } from '../lib/exists.js';

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const PRIMITIVE_KEY = new Map(PRIMITIVES.map((one) => [one.id, one.key]));
const OBJECT_KEY = new Map(OBJECT_KINDS.map((one) => [one.id, one.key]));

/** 一格候选：`{primitive, primitiveKey, objectKind, objectKey}`，跟 grid.js buildGrid 的形状一致 */
const cell = (primitive, objectKind) => ({
  primitive,
  primitiveKey: PRIMITIVE_KEY.get(primitive) ?? primitive,
  objectKind,
  objectKey: OBJECT_KEY.get(objectKind) ?? objectKind,
});

/** 读侧原语（与 grid.js ROLE_READ 同一份口径，两处一致性另有断言钉住） */
const READONLY = new Set(['inspect', 'external-research']);

/**
 * 候选夹具：默认是一对 `inspect×files → edit-file×files`。
 * 传平铺的 primitive / objectKind 时当作**动作格**（老用例就是这么写的），读格自动配
 * `inspect×同一个对象类`；给只读原语时 action 落 null（单段读那一格）。
 */
const candidate = ({ primitive = 'edit-file', objectKind = 'files', read, action, ...rest } = {}) => ({
  id: 'C01',
  read: read !== undefined ? read : cell('inspect', objectKind),
  action: action !== undefined ? action : (READONLY.has(primitive) ? null : cell(primitive, objectKind)),
  material: '翻仓库找跑不过的测试',
  motivation: 'hygiene',
  note: '读 读 × 文件 → 动 改文件 × 文件｜有副作用 auto',
  score: 39,
  defaults: { impact: 'local-write', reversibility: 'auto' },
  ...rest,
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

/** 默认 stub：文件在、行号对；单测要改哪一项就覆盖哪一项 */
const stubDeps = (over = {}) => ({
  checkExists: async () => ({
    status: 'ok',
    ok: true,
    path: '/srv/app/plugins/dsh-ego/lib/gate.js',
    reason: '',
  }),
  checkFileLine: async () => ({ status: 'ok', ok: true, from: 36, to: 36, totalLines: 943, reason: '' }),
  ...over,
});

const gAs = (list) => list.map((one) => one.ga);

/* ── GA1：pick 与开关 ─────────────────────────────────────────────── */

test('GA1：pick 是本拍候选就过；造格子拒；空串当没话说放行', () => {
  const ok = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.equal(ok.ok, true);
  assert.deepEqual(gAs(ok.reject), []);

  const madeUp = checkStage2Plan(plan({ pick: 'C99' }), { candidates: [candidate()] });
  assert.equal(madeUp.ok, true, '可重写降级，不是硬拒');
  assert.deepEqual([...new Set(gAs(madeUp.downgrade))], ['GA1']);
  assert.match(madeUp.downgrade.find((one) => one.ga === 'GA1').why, /不是这一拍的候选/);
  assert.equal(madeUp.downgrade[0].code, 'GA1');
  assert.equal(madeUp.downgrade[0].originalAction, 'silent', '原本是拒，用满次数落回 silent');

  const quiet = checkStage2Plan(plan({ pick: '', idea: '', why: '今天没什么好说的' }), { candidates: [candidate()] });
  assert.equal(quiet.ok, true);
  assert.equal(quiet.allowDo, true);
});

test('GA1：原语或对象在配置里关着时，旧 id 也拒', () => {
  const off = checkStage2Plan(plan(), {
    candidates: [candidate()],
    enabled: { primitives: { inspect: false }, objects: { files: true } },
  });
  assert.deepEqual([...new Set(gAs(off.downgrade))], ['GA1']);
  assert.match(off.downgrade.find((one) => one.ga === 'GA1').why, /原语「inspect」在配置里是关着的/);

  const objOff = checkStage2Plan(plan(), {
    candidates: [candidate()],
    enabled: { primitives: { inspect: true }, objects: { files: false } },
  });
  assert.deepEqual([...new Set(gAs(objOff.downgrade))], ['GA1']);
  assert.match(objOff.downgrade.find((one) => one.ga === 'GA1').why, /对象类别「files」/);
});

/* ── GA2：kind 一致与配对矩阵 ──────────────────────────────────────── */

test('GA2：object.kind 与 pick 那一格对不上就拒；steps 不在矩阵里也拒', () => {
  const wrongKind = checkStage2Plan(plan({
    pick: 'C02',
    object: { kind: 'service', value: 'nginx', anchor: 'nginx:1' },
  }), { candidates: [candidate({ id: 'C02', primitive: 'edit-file', primitiveKey: 'editFile', objectKind: 'files' })], pairs: PAIR_SET });
  assert.deepEqual([...new Set(gAs(wrongKind.downgrade))], ['GA2']);
  assert.match(wrongKind.downgrade.find((one) => one.ga === 'GA2').why, /object.kind 却写成 service/);

  const badStep = checkStage2Plan(plan({ plan: { steps: ['P1×files', 'P2×files', 'P8×config'], files: [], estLines: 0 } }), {
    candidates: [candidate()],
    pairs: PAIR_SET,
  });
  assert.deepEqual([...new Set(gAs(badStep.downgrade))], ['GA2']);
  assert.match(badStep.downgrade.find((one) => one.ga === 'GA2').why, /P8×config.*不在配对矩阵里/);

  const goodStep = checkStage2Plan(plan({ pick: 'C02', plan: { steps: ['P1×files', 'P2×files'], files: ['lib/gate.js'], estLines: 0 } }), {
    candidates: [candidate({ id: 'C02', primitive: 'edit-file', primitiveKey: 'editFile', objectKind: 'files' })],
    pairs: PAIR_SET,
  });
  assert.equal(goodStep.ok, true);

  // 没给矩阵就标 unsupported，不假装核过
  const noMatrix = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.ok(gAs(noMatrix.unsupported).includes('GA2'));

  // 配对矩阵只有 Set 一种形状；对象写法不再猜着解析，按未核记
  const objectForm = checkStage2Plan(plan({ plan: { steps: ['P2×files'], files: [], estLines: 0 } }), {
    candidates: [candidate()],
    pairs: { 'edit-file': ['files'] },
  });
  assert.deepEqual(gAs(objectForm.unsupported).filter((ga) => ga === 'GA2'), ['GA2']);
  assert.equal(objectForm.downgrade.some((one) => one.ga === 'GA2'), false, '不许把对象写法当矩阵悄悄放行');
});

/* ── GA3 / GA4 / GA5：注入 deps 读盘 ───────────────────────────────── */

test('GA3：stub 说文件在就过，说不在就变成可重写降级；未注入 deps 只标未核', async () => {
  const gate = createGate({ deps: stubDeps() });
  const ok = await gate.checkPlan(plan(), { candidates: [candidate()] });
  assert.equal(ok.ok, true);

  const missing = createGate({
    deps: stubDeps({ checkExists: async () => ({ status: 'missing', ok: false, path: '', reason: '路径不存在（realpath 失败）' }) }),
  });
  const bad = await missing.checkPlan(plan(), { candidates: [candidate()] });
  assert.equal(bad.ok, true, '可重写降级，不是硬拒');
  assert.ok(gAs(bad.downgrade).includes('GA3'));
  const ga3 = bad.downgrade.find((one) => one.ga === 'GA3');
  assert.equal(ga3.code, 'GA3');
  assert.equal(ga3.originalAction, 'silent', '原本是拒，用满次数落回 silent');

  const bare = createGate();
  const unchecked = await bare.checkPlan(plan(), { candidates: [candidate()] });
  assert.equal(unchecked.ok, true, '未核不是不合格');
  assert.ok(gAs(unchecked.unsupported).includes('GA3'));
});

test('GA3：files 类 object.value 带括号说明或列多个文件 → 真读盘按不存在拒（21:06 那串的反例）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-ga3-'));
  const log = path.join(dir, 'app.log');
  fs.writeFileSync(log, 'one\ntwo\n', 'utf8');
  const realDeps = {
    checkExists: (object) => checkExists(object, { roots: [dir] }),
    checkFileLine: async () => ({ status: 'ok', ok: true, from: 2, to: 2, totalLines: 2, reason: '' }),
  };
  try {
    const gate = createGate({ deps: realDeps });
    // 纯路径：过
    const ok = await gate.checkPlan(plan({
      idea: '日志第 2 行有报错，顺手补掉',
      object: { kind: 'files', value: log, anchor: `${log}:2` },
      evidence: [{ claim: '第 2 行有报错', source: 'read', value: '2', at: '2026-11-10T05:28:00Z' }],
    }), { candidates: [candidate()], tmpAllowlist: [dir] });
    assert.equal(ok.ok, true, JSON.stringify(ok.reject));

    // 带括号说明：整串不是路径 → realpath 失败 → GA3 可重写降级
    const paren = await gate.checkPlan(plan({
      object: { kind: 'files', value: `${log}（第 2 行）`, anchor: `${log}:2` },
    }), { candidates: [candidate()], tmpAllowlist: [dir] });
    assert.equal(paren.ok, true, '可重写降级，不是硬拒');
    assert.ok(gAs(paren.downgrade).includes('GA3'));
    assert.match(paren.downgrade.find((one) => one.ga === 'GA3').why, /对象不存在/);

    // 一行列多个文件：同样不是路径 → GA3 可重写降级
    const many = await gate.checkPlan(plan({
      object: { kind: 'files', value: `${log} 另含 ${path.join(dir, 'x.state.json')}、${path.join(dir, 'x.sh')}`, anchor: `${log}:2` },
    }), { candidates: [candidate()], tmpAllowlist: [dir] });
    assert.equal(many.ok, true, '可重写降级，不是硬拒');
    assert.ok(gAs(many.downgrade).includes('GA3'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GA3：service 类不写半截核查，收进 unsure 交给 arbiter', async () => {
  const c = candidate({ primitive: 'service', primitiveKey: 'service', objectKind: 'service', objectKey: 'service', defaults: { impact: 'process', reversibility: 'manual' } });
  const verdict = await createGate({ deps: stubDeps() }).checkPlan(plan({
    object: { kind: 'service', value: 'nginx', anchor: 'nginx' },
    plan: { steps: ['P1×service', 'P4×service'], files: [], estLines: 0 },
    evidence: [{ claim: '服务在跑', source: 'sbi_status', value: '36', at: '2026-11-10T05:28:00Z' }],
    intent: { impact: { paths: [], services: ['nginx'], remotes: [] }, reversibility: 'manual', undo: { kind: '', ref: '', howto: 'systemctl start nginx' } },
  }), { candidates: [c] });
  assert.equal(verdict.reject.length, 0);
  const note = verdict.unsure.find((one) => one.ga === 'GA3');
  assert.ok(note, 'gate 判不了的服务类要进 unsure，等 arbiter 判');
  assert.match(note.why, /host_status 不给 systemd unit 列表/);
  assert.match(note.subject, /service/, 'subject 要写清这条针对方案里的哪一部分');
  assert.equal(verdict.unsupported.some((one) => one.ga === 'GA3'), false, '送 arbiter 的分支不再直接记 unsupported');
});

test('GA4：行号 stub 说超界就拒；非文件:行号锚点标未核', async () => {
  const behind = createGate({
    deps: stubDeps({ checkFileLine: async () => ({ status: 'missing', ok: false, from: 9999, to: 9999, totalLines: 943, reason: '行号 9999 超过总行数 943' }) }),
  });
  const bad = await behind.checkPlan(plan(), { candidates: [candidate()] });
  assert.equal(bad.ok, false);
  assert.ok(gAs(bad.reject).includes('GA4'));
  assert.match(bad.reject.find((one) => one.ga === 'GA4').why, /行号 9999 超过总行数 943/);

  const noLine = await createGate({ deps: stubDeps() }).checkPlan(plan({
    object: { kind: 'files', value: 'lib/gate.js', anchor: 'gate 这个文件' },
  }), { candidates: [candidate()] });
  assert.equal(noLine.ok, true);
  assert.ok(gAs(noLine.unsure).includes('GA4'), '锚点形状不常规 → unsure，交 arbiter 判');
  assert.equal(gAs(noLine.unsupported).includes('GA4'), false, '不再直接记 unsupported');
});

test('GA5：realpath 落在 /tmp 里拒；允许根外拒；白名单可放行', async () => {
  const inTmp = createGate({
    deps: stubDeps({ checkExists: async () => ({ status: 'ok', ok: true, path: '/tmp/ego/build.log', reason: '' }) }),
  });
  const bad = await inTmp.checkPlan(plan(), { candidates: [candidate()] });
  assert.equal(bad.ok, false);
  assert.ok(gAs(bad.reject).includes('GA5'));
  assert.match(bad.reject.find((one) => one.ga === 'GA5').why, /落在 \/tmp 里/);

  const allowed = await inTmp.checkPlan(plan(), { candidates: [candidate()], tmpAllowlist: ['/tmp/ego'] });
  assert.equal(allowed.ok, true);

  const denied = createGate({
    deps: stubDeps({ checkExists: async () => ({ status: 'denied', ok: false, path: '/etc/shadow', reason: 'realpath 后不在允许根内' }) }),
  });
  const outside = await denied.checkPlan(plan(), { candidates: [candidate()] });
  assert.equal(outside.ok, false);
  assert.ok(gAs(outside.reject).includes('GA5'));
});

test('GA3/GA4/GA5 走 options.deps 覆盖构造时那一份', async () => {
  const gate = createGate({ deps: stubDeps() });
  const overridden = await gate.checkPlan(plan(), {
    candidates: [candidate()],
    deps: { checkExists: async () => ({ status: 'missing', ok: false, path: '', reason: '路径不存在' }) },
  });
  assert.equal(overridden.ok, true, '可重写降级，不是硬拒');
  assert.ok(gAs(overridden.downgrade).includes('GA3'));
  assert.equal(typeof gate.deps.checkExists, 'function');
});

/* ── GA6：不许比候选默认更宽松 ────────────────────────────────────── */

test('GA6：delete 格默认 none，方案写 auto / manual 都拒，写 none 过', () => {
  const del = candidate({
    id: 'C06',
    primitive: 'delete',
    primitiveKey: 'delete',
    objectKind: 'files',
    objectKey: 'files',
    defaults: { impact: 'irreversible', reversibility: 'none' },
  });
  const delSteps = { plan: { steps: ['P1×files', 'P6×files'], files: [], estLines: 0 } };
  const loose = checkStage2Plan(plan({
    pick: 'C06',
    ...delSteps,
    intent: { impact: { paths: ['/tmp/x'], services: [], remotes: [] }, reversibility: 'auto', undo: { kind: '', ref: '', howto: 'cp /tmp/x /tmp/x.bak' } },
  }), { candidates: [del] });
  assert.deepEqual([...new Set(gAs(loose.downgrade))], ['GA6']);
  assert.match(loose.downgrade.find((one) => one.ga === 'GA6').why, /候选 C06 的默认档是 none，方案写的是 auto/);
  assert.equal(loose.downgrade[0].code, 'GA6');
  assert.equal(loose.downgrade[0].originalAction, 'silent', '原本是拒，用满次数落回 silent');

  const halfLoose = checkStage2Plan(plan({
    pick: 'C06',
    ...delSteps,
    intent: { impact: { paths: ['/tmp/x'], services: [], remotes: [] }, reversibility: 'manual', undo: { kind: '', ref: '', howto: 'cp /tmp/x /tmp/x.bak' } },
  }), { candidates: [del] });
  assert.deepEqual([...new Set(gAs(halfLoose.downgrade))], ['GA6']);

  const same = checkStage2Plan(plan({
    pick: 'C06',
    ...delSteps,
    intent: { impact: { paths: ['/tmp/x'], services: [], remotes: [] }, reversibility: 'none', undo: { kind: '', ref: '', howto: 'cp /tmp/x /tmp/x.bak' } },
  }), { candidates: [del] });
  assert.equal(same.ok, true);
});

test('GA6：edit-file 格默认 auto，方案写 manual（更保守）过；不写 reversibility 拒', () => {
  const edit = candidate({
    id: 'C02',
    primitive: 'edit-file',
    primitiveKey: 'editFile',
    objectKind: 'files',
    defaults: { impact: 'local-write', reversibility: 'auto' },
  });
  const conservative = checkStage2Plan(plan({
    pick: 'C02',
    intent: {
      impact: { paths: ['lib/gate.js'], services: [], remotes: [] },
      reversibility: 'manual',
      undo: { kind: 'git-checkout', ref: 'lib/gate.js', howto: 'git checkout -- lib/gate.js' },
    },
  }), { candidates: [edit] });
  assert.equal(conservative.ok, true);

  const blank = checkStage2Plan(plan({
    pick: 'C02',
    intent: { impact: { paths: ['lib/gate.js'], services: [], remotes: [] }, reversibility: '', undo: { kind: '', ref: '', howto: 'git checkout -- lib/gate.js' } },
  }), { candidates: [edit] });
  assert.deepEqual([...new Set(gAs(blank.downgrade))], ['GA6']);
  assert.match(blank.downgrade.find((one) => one.ga === 'GA6').why, /没写 reversibility/);
});

test('GA6：impact 少了候选默认要求的那一栏也拒', () => {
  const edit = candidate({
    id: 'C02',
    primitive: 'edit-file',
    primitiveKey: 'editFile',
    objectKind: 'files',
    defaults: { impact: 'local-write', reversibility: 'auto' },
  });
  const empty = checkStage2Plan(plan({
    pick: 'C02',
    intent: { impact: { paths: [], services: [], remotes: [] }, reversibility: 'auto', undo: { kind: '', ref: '', howto: 'git checkout -- lib/gate.js' } },
  }), { candidates: [edit] });
  assert.deepEqual([...new Set(gAs(empty.downgrade))], ['GA6']);
  assert.match(empty.downgrade.find((one) => one.ga === 'GA6').why, /intent\.impact\.paths 是空的/);

  assert.deepEqual(IMPACT_SLOTS['local-write'], ['paths']);
  assert.deepEqual(IMPACT_SLOTS['read-remote'], ['remotes']);

  const filled = checkStage2Plan(plan({
    pick: 'C02',
    intent: { impact: { paths: ['lib/gate.js'], services: [], remotes: [] }, reversibility: 'auto', undo: { kind: '', ref: '', howto: 'git checkout -- lib/gate.js' } },
  }), { candidates: [edit] });
  assert.equal(filled.ok, true);
});

test('GA6：撤回档的保守顺序是 auto < manual < none', () => {
  assert.ok(REVERSIBILITY_RANK.auto < REVERSIBILITY_RANK.manual);
  assert.ok(REVERSIBILITY_RANK.manual < REVERSIBILITY_RANK.none);
});

/* ── GA7：undo 模板 ────────────────────────────────────────────────── */

test('GA7：命中原语模板就过；空话、太短、模板不匹配都降级', () => {
  const edit = candidate({
    id: 'C02', primitive: 'edit-file', primitiveKey: 'editFile', objectKind: 'files',
    defaults: { impact: 'local-write', reversibility: 'auto' },
  });
  const withUndo = (howto) => plan({
    pick: 'C02',
    intent: {
      impact: { paths: ['lib/gate.js'], services: [], remotes: [] },
      reversibility: 'auto',
      undo: { kind: 'git-checkout', ref: 'lib/gate.js', howto },
    },
  });

  const good = checkStage2Plan(withUndo('git checkout -- lib/gate.js'), { candidates: [edit] });
  assert.equal(good.ok, true);
  assert.deepEqual(good.downgrade, []);

  const emptyTalk = checkStage2Plan(withUndo('整理一下'), { candidates: [edit] });
  assert.equal(emptyTalk.ok, true);
  assert.deepEqual(gAs(emptyTalk.downgrade), ['GA7']);

  const noTemplate = checkStage2Plan(withUndo('跑一遍 node --test 看结果'), { candidates: [edit] });
  assert.deepEqual(gAs(noTemplate.downgrade), ['GA7']);
  assert.match(noTemplate.downgrade[0].why, /没命中 edit-file 的撤回模板/);

  const service = candidate({
    id: 'C04', primitive: 'service', primitiveKey: 'service', objectKind: 'service', objectKey: 'service',
    defaults: { impact: 'process', reversibility: 'manual' },
  });
  const serviceOk = checkStage2Plan(plan({
    pick: 'C04',
    object: { kind: 'service', value: 'nginx', anchor: 'nginx' },
    evidence: [{ claim: 'nginx 在跑', source: 'sbi_status', value: '36', at: '2026-11-10T05:28:00Z' }],
    intent: { impact: { paths: [], services: ['nginx'], remotes: [] }, reversibility: 'manual', undo: { kind: '', ref: '', howto: 'systemctl start nginx' } },
  }), { candidates: [service] });
  assert.equal(serviceOk.downgrade.some((one) => one.ga === 'GA7'), false, 'service 撤回模板命中就不报 GA7');

  const readonly = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.equal(readonly.downgrade.some((one) => one.ga === 'GA7'), false, '只读原语不要求 undo');
});

/* ── GA8：自指方案要有 P8 产出与本仓行号 ───────────────────────────── */

test('GA8：自指方案两样都有就过；缺 URL 或缺本仓行号都降级；非自指不受限', () => {
  const selfPlan = plan({
    idea: 'dsh-ego 的 lib/gate.js 在 36 行有个重复分支，按上游文档整理掉',
    why: '上游 2026 年那版把 gate 拆成两半了',
    evidence: [
      { claim: '上游文档说 gate 拆两半 https://example.com/gate.md', source: 'web_fetch', value: '36', at: '2026-11-10T05:28:00Z' },
    ],
  });
  const both = checkStage2Plan(selfPlan, { candidates: [candidate()] });
  assert.equal(both.ok, true);
  assert.deepEqual(both.downgrade, []);

  const noUrl = checkStage2Plan(plan({
    idea: 'dsh-ego 的 lib/gate.js 在 36 行有个重复分支',
    evidence: [{ claim: '重复分支在第 36 行', source: 'read', value: '36', at: '2026-11-10T05:28:00Z' }],
  }), { candidates: [candidate()] });
  assert.deepEqual(gAs(noUrl.downgrade), ['GA8']);
  assert.match(noUrl.downgrade[0].why, /没有一条外部资料/);

  const noRepoLine = checkStage2Plan(plan({
    idea: 'dsh-ego 的服务该重启一下',
    object: { kind: 'service', value: 'nginx', anchor: 'nginx' },
    evidence: [{ claim: '上游 https://example.com/x 说要重启', source: 'web_fetch', value: '36', at: '2026-11-10T05:28:00Z' }],
    plan: { steps: ['P1×service'], files: [], estLines: 0 },
    intent: {
      impact: { paths: [], services: [], remotes: [] },
      reversibility: 'auto',
      undo: { kind: '', ref: '', howto: '' },
    },
  }), { candidates: [candidate()] });
  assert.ok(gAs(noRepoLine.downgrade).includes('GA8'));
  assert.match(noRepoLine.downgrade.find((one) => one.ga === 'GA8').why, /文件:行号/);

  const normal = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.deepEqual(normal.downgrade, []);
});

/* ── FILE_LINE_PATTERN：「文件:行号」的形状（GA4 / GA8 / proposer 点子校验共用） ── */

test('FILE_LINE_PATTERN：老六种后缀照旧，新增后缀 / 固定名 / 备份戳也认', () => {
  const yes = [
    'lib/gate.js:36', 'lib/gate.js:36-40', 'cordis.patch.yml:11', 'docs/gate-rules.md:100',
    'lib/boot.mjs:1', 'lib/boot.cjs:1', 'a/b/c.yaml:7',
    'package.json:19', 'tsconfig.json:8', 'src/index.ts:42', 'src/App.tsx:9',
    'scripts/release.sh:20', 'Cargo.toml:3', 'conf/nginx.conf:14', 'notes.txt:2',
    'package-lock.json:88', '.editorconfig:5',
    '.gitignore:11', '.npmignore:4', '.dockerignore:7', 'Dockerfile:12', 'deploy/Dockerfile:12', 'Makefile:3',
    'package.json.bak-20261117:19', 'cordis.patch.yml.bak-20261115-0013:1258',
    '~/fatfish/plugins/dsh-ego/lib/route.js:104-108',
  ];
  for (const one of yes) assert.equal(FILE_LINE_PATTERN.test(one), true, `应匹配：${one}`);
});

test('FILE_LINE_PATTERN：URL / 裸时间 / ISO 时间戳 / GA8:1 不算文件:行号', () => {
  const no = [
    'http://127.0.0.1:61208',
    'http://10.0.0.5:8080/path',
    '12:30',
    '08:40-09:00',
    '2026-11-18T00:34:21Z',
    'GA8:1',
    'nginx:1',
    'v1.2.3:4',
    't-mwlef86m-x1pv:2',
  ];
  for (const one of no) assert.equal(FILE_LINE_PATTERN.test(one), false, `不该匹配：${one}`);
});

test('GA8：anchor 是 .gitignore:11 / package.json.bak-20261117:19 时不再判「没给本仓文件:行号」', () => {
  const selfPlan = (anchor) => {
    const file = anchor.slice(0, anchor.lastIndexOf(':'));
    const line = anchor.slice(anchor.lastIndexOf(':') + 1);
    return plan({
      idea: `dsh-ego 的 ${file} 第 ${line} 行要补一条规则`,
      object: { kind: 'files', value: file, anchor },
      evidence: [{
        claim: '上游文档 https://example.com/ignore.md 说这条要加',
        source: 'web_fetch',
        value: line,
        at: '2026-11-10T05:28:00Z',
      }],
      plan: { steps: ['P1×files', 'P2×files'], files: [anchor], estLines: 1 },
      intent: {
        impact: { paths: [file], services: [], remotes: [] },
        reversibility: 'auto',
        undo: { kind: 'file', ref: '', howto: `git checkout -- ${file}` },
      },
    });
  };
  for (const anchor of ['.gitignore:11', 'package.json.bak-20261117:19', 'package.json:19', 'cordis.patch.yml:11']) {
    const out = checkStage2Plan(selfPlan(anchor), { candidates: [candidate()] });
    assert.equal(
      out.downgrade.some((one) => one.ga === 'GA8'),
      false,
      `有本仓行号就不该报 GA8：${anchor} → ${JSON.stringify(gAs(out.downgrade))}`,
    );
  }
});

test('GA8：anchor 只有 12:30 或 http://127.0.0.1:61208 时仍判没给本仓行号', () => {
  const barePlan = (anchor) => plan({
    idea: `dsh-ego 在 ${anchor} 这处有问题`,
    object: { kind: 'files', value: anchor, anchor },
    evidence: [{
      claim: '上游文档 https://example.com/x 提到',
      source: 'web_fetch',
      value: '1',
      at: '2026-11-10T05:28:00Z',
    }],
    plan: { steps: ['P1×files', 'P2×files'], files: [], estLines: 0 },
    intent: {
      impact: { paths: [], services: [], remotes: [] },
      reversibility: 'auto',
      undo: { kind: '', ref: '', howto: '' },
    },
  });
  for (const anchor of ['12:30', 'http://127.0.0.1:61208']) {
    const out = checkStage2Plan(barePlan(anchor), { candidates: [candidate()] });
    const why = out.downgrade.filter((one) => one.ga === 'GA8').map((one) => one.why).join('\n');
    assert.match(why, /文件:行号/, `应判没给本仓行号：${anchor} → ${JSON.stringify(gAs(out.downgrade))}`);
  }
});

/* ── GA9：外网 URL 只许 http(s) ────────────────────────────────────── */

test('GA9：外网 http(s) 过；内网、本机、file 协议都拒', () => {
  const ok = checkStage2Plan(plan({ why: '参考 https://example.com/doc 的写法' }), { candidates: [candidate()] });
  assert.equal(ok.ok, true);

  const lan = checkStage2Plan(plan({ why: '打 http://10.0.0.7/x 看看' }), { candidates: [candidate()] });
  assert.deepEqual(gAs(lan.reject), ['GA9']);
  assert.match(lan.reject[0].why, /本机或内网/);

  const fileUrl = checkStage2Plan(plan({ why: '读 file:///etc/passwd 就行' }), { candidates: [candidate()] });
  assert.deepEqual(gAs(fileUrl.reject), ['GA9']);
  assert.match(fileUrl.reject[0].why, /只能写 http\(s\)/);

  const ten = checkStage2Plan(plan({ why: 'http://10.1.2.3/x 上有份数据' }), { candidates: [candidate()] });
  assert.deepEqual(gAs(ten.reject), ['GA9']);

  const internal = checkStage2Plan(plan({ why: 'https://git.corp.internal/x 上有' }), { candidates: [candidate()] });
  assert.deepEqual(gAs(internal.reject), ['GA9']);
});

/* ── GA10：idea 的数字要有据 ───────────────────────────────────────── */

test('GA10：idea 里每个数字都要在 evidence[].value 里找到字面出处', () => {
  const ok = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.equal(ok.ok, true);
  assert.equal(ok.unsure.some((one) => one.ga === 'GA10'), false, '36 在 evidence.value 里有出处，不该进 arbiter');

  const extra = checkStage2Plan(plan({
    idea: 'lib/gate.js 里有 36 行重复分支，另外 55 行注释也太旧',
  }), { candidates: [candidate()] });
  const notes = extra.unsure.filter((one) => one.ga === 'GA10');
  assert.equal(notes.length, 1, '缺的数字汇成一条，不一个数字一条');
  assert.match(notes[0].why, /55/);
  assert.equal(/36/.test(notes[0].why), false, '36 有出处，不该被点名');
  assert.equal(extra.downgrade.some((one) => one.ga === 'GA10'), false, 'GA10 不再自己判，交 arbiter');

  // 数字从 claim 里拿不算：只认 evidence[].value
  const onlyClaim = checkStage2Plan(plan({
    evidence: [{ claim: '重复分支在第 36 行', source: 'read', value: '', at: '2026-11-10T05:28:00Z' }],
  }), { candidates: [candidate()] });
  assert.ok(onlyClaim.unsure.some((one) => one.ga === 'GA10' && /36/.test(one.why)));
});

test('GA10：日期和时刻先遮掉，旁边的真数字照核', () => {
  const dateOnly = checkStage2Plan(plan({
    idea: '2026-11-10 16:18:01 那拍日志里没什么异常',
    evidence: [],
  }), { candidates: [candidate()] });
  assert.deepEqual(gAs(dateOnly.reject), []);
  assert.equal(dateOnly.unsure.some((one) => one.ga === 'GA10'), false);

  const shortDate = checkStage2Plan(plan({
    idea: '11-10 那天 16:18 的日志里没什么异常',
    evidence: [],
  }), { candidates: [candidate()] });
  assert.deepEqual(gAs(shortDate.reject), []);
  assert.equal(shortDate.unsure.some((one) => one.ga === 'GA10'), false);

  const mixed = checkStage2Plan(plan({
    idea: '2026-11-10 16:18 的日志里有 36 行重复，718 行那条也是',
  }), { candidates: [candidate()] });
  const note = mixed.unsure.find((one) => one.ga === 'GA10');
  assert.ok(note);
  assert.match(note.why, /718/);
  assert.equal(/36/.test(note.why), false, '36 在 evidence.value 里有出处，不该被点名');
});

test('GA10：行号、区间、百分比都按字面核，汇总成一条', () => {
  const lineNumber = checkStage2Plan(plan({
    idea: '日志 718 行有报错',
  }), { candidates: [candidate()] });
  assert.ok(lineNumber.unsure.some((one) => one.ga === 'GA10' && /718/.test(one.why)));

  const withPath = checkStage2Plan(plan({
    idea: 'lib/gate.js:718 有个重复分支',
  }), { candidates: [candidate()] });
  assert.ok(withPath.unsure.some((one) => one.ga === 'GA10' && /718/.test(one.why)));

  // 36 在 evidence.value 里有出处，40 没有：只点名 40
  const range = checkStage2Plan(plan({
    idea: '第 36-40 行有重复分支',
  }), { candidates: [candidate()] });
  const note = range.unsure.find((one) => one.ga === 'GA10');
  assert.ok(note);
  assert.match(note.why, /40/);
  assert.equal(/36/.test(note.why), false);

  // 3 处、5 条这种计数也不猜着放行，一并列给 arbiter 看
  const counts = checkStage2Plan(plan({
    idea: '改了 3 处、删了 5 条，磁盘还剩 0.1% 的可能',
  }), { candidates: [candidate()] });
  const aggregate = counts.unsure.filter((one) => one.ga === 'GA10');
  assert.equal(aggregate.length, 1);
  assert.match(aggregate[0].why, /3、5、0\.1/);
  assert.match(aggregate[0].subject, /证据|evidence/);
  assert.match(aggregate[0].subject, /改了 3 处/);
});

/* ── GA11：峰价禁网 ────────────────────────────────────────────────── */

test('GA11：峰价 + 外部检索格降级；谷价过；峰价 + 本地读不受限', () => {
  const external = candidate({
    id: 'C08', primitive: 'external-research', primitiveKey: 'externalResearch',
    objectKind: 'external-doc', objectKey: 'externalDoc',
    defaults: { impact: 'read-remote', reversibility: 'auto' },
  });
  const extPlan = plan({
    pick: 'C08',
    idea: '上游文档 36 页里有一节讲 gate 的顺序',
    object: { kind: 'external-doc', value: 'https://example.com/doc', anchor: 'https://example.com/doc@2026-11-10T05:28:00Z' },
    evidence: [{ claim: '文档写了 36 页', source: 'web_fetch', value: '36', at: '2026-11-10T05:28:00Z' }],
    plan: { steps: ['P8×external-doc'], files: [], estLines: 0 },
    intent: { impact: { paths: [], services: [], remotes: [] }, reversibility: 'auto', undo: { kind: '', ref: '', howto: '' } },
  });

  const peak = checkStage2Plan(extPlan, { candidates: [external], pairs: PAIR_SET, peak: true });
  assert.ok(gAs(peak.downgrade).includes('GA11'));
  assert.match(peak.downgrade.find((one) => one.ga === 'GA11').why, /峰价时段/);
  // GA11 判不了（峰价是外部条件），不接 rewrite：没有 code
  assert.equal(peak.downgrade.find((one) => one.ga === 'GA11').code, undefined);

  const offPeak = checkStage2Plan(extPlan, { candidates: [external], pairs: PAIR_SET, peak: false });
  assert.equal(gAs(offPeak.downgrade).includes('GA11'), false);

  const local = checkStage2Plan(plan(), { candidates: [candidate()], peak: true });
  assert.equal(gAs(local.downgrade).includes('GA11'), false);
});

test('GA11：不看 evidence.source 写没写 web_*（模型漏写就绕过的坑）', () => {
  const external = candidate({
    id: 'C08', primitive: 'external-research', primitiveKey: 'externalResearch',
    objectKind: 'external-doc', objectKey: 'externalDoc',
    defaults: { impact: 'read-remote', reversibility: 'auto' },
  });
  // evidence.source 故意写成本地工具名：仍要按候选格判成要上网
  const sneaky = plan({
    pick: 'C08',
    idea: '上游文档 36 页里有一节',
    object: { kind: 'external-doc', value: 'https://example.com/doc', anchor: 'https://example.com/doc@2026-11-10T05:28:00Z' },
    evidence: [{ claim: '文档 36 页', source: 'read', value: '36', at: '2026-11-10T05:28:00Z' }],
    plan: { steps: ['P8×external-doc'], files: [], estLines: 0 },
    intent: { impact: { paths: [], services: [], remotes: [] }, reversibility: 'auto', undo: { kind: '', ref: '', howto: '' } },
  });
  const verdict = checkStage2Plan(sneaky, { candidates: [external], pairs: PAIR_SET, peak: true });
  assert.ok(gAs(verdict.downgrade).includes('GA11'));
});

/* ── GA12：幅度 ────────────────────────────────────────────────────── */

test('GA12：5 步以内、3 个文件以内、40 行以内都过；超一项降级', () => {
  const steps = (n) => plan({ plan: { steps: Array.from({ length: n }, () => 'P1×files'), files: ['lib/gate.js'], estLines: 0 } });
  assert.equal(gAs(checkStage2Plan(steps(4), { candidates: [candidate()] }).downgrade).includes('GA12'), false);
  const overSteps = checkStage2Plan(steps(6), { candidates: [candidate()] });
  assert.deepEqual(gAs(overSteps.downgrade).filter((ga) => ga === 'GA12'), ['GA12']);
  assert.equal(overSteps.downgrade.find((one) => one.ga === 'GA12').code, 'steps', 'steps 超限也带 code');

  const files = plan({ plan: { steps: ['P1×files'], files: ['a.js', 'b.js', 'c.js', 'd.js'], estLines: 0 } });
  assert.equal(files.plan, files.plan);
  const overFiles = checkStage2Plan(files, { candidates: [candidate()] });
  assert.equal(overFiles.downgrade.find((one) => one.ga === 'GA12').code, 'files');

  const long = plan({ plan: { steps: ['P1×files'], files: ['lib/gate.js'], estLines: 60 } });
  const overLines = checkStage2Plan(long, { candidates: [candidate()] });
  assert.equal(overLines.downgrade.find((one) => one.ga === 'GA12').code, 'estLines', 'estLines 超限也带 code');
});

/* ── GA13：轻校验（12h 冷却的准在 grid） ───────────────────────────── */

test('GA13：同一素材连续两拍降级；换了素材就过', () => {
  const same = checkStage2Plan(plan(), { candidates: [candidate()], previousMaterial: '翻仓库找跑不过的测试' });
  assert.deepEqual(gAs(same.downgrade), ['GA13']);

  const changed = checkStage2Plan(plan(), { candidates: [candidate()], previousMaterial: '别的方向' });
  assert.deepEqual(changed.downgrade, []);

  // 自指 12h 冷却不在 gate 里再做一道：这里不读 lastSelfIdeaAt
  const selfPlan = plan({ idea: 'dsh-ego 的 lib/gate.js:36 有个重复分支' });
  const noCooldown = checkStage2Plan(selfPlan, { candidates: [candidate({ material: '别的方向' })], lastSelfIdeaAt: Date.now() });
  assert.equal(noCooldown.downgrade.some((one) => one.ga === 'GA13'), false, '12h 冷却不在 gate 里再判一次');
  assert.equal(noCooldown.hits.includes('GA13'), false);
});

/* ── GA6 实例级：动服务的 stop/disable 压到 none ─────────────────────── */

const serviceCandidate = () => candidate({
  id: 'C04',
  primitive: 'service',
  primitiveKey: 'service',
  objectKind: 'service',
  objectKey: 'service',
  defaults: { impact: 'process', reversibility: 'manual' },
});

const servicePlan = (reversibility, over = {}) => plan({
  pick: 'C04',
  object: { kind: 'service', value: 'nginx', anchor: 'nginx' },
  evidence: [{ claim: 'nginx 在跑', source: 'sbi_status', value: '36', at: '2026-11-10T05:28:00Z' }],
  plan: { steps: ['P4×service'], files: [], estLines: 0 },
  intent: {
    impact: { paths: [], services: ['nginx'], remotes: [] },
    reversibility,
    dryRun: { ok: true, detail: 'systemctl status nginx' },
    undo: { kind: '', ref: '', howto: 'systemctl start nginx' },
  },
  ...over,
});

test('GA6 实例级：service + systemctl stop 要求 none，写 manual / auto 都拒', () => {
  const stopped = { plan: { steps: ['P1×service', 'P4×service：systemctl stop nginx'], files: [], estLines: 0 } };

  const manual = checkStage2Plan(servicePlan('manual', stopped), { candidates: [serviceCandidate()] });
  assert.equal(manual.ok, true, '可重写降级，不是硬拒');
  assert.deepEqual([...new Set(gAs(manual.downgrade))], ['GA6']);
  assert.match(manual.downgrade.find((one) => one.ga === 'GA6').why, /stop\/disable 撤不回，档要写 none/);
  assert.equal(manual.hits.includes('GA6'), true);

  const auto = checkStage2Plan(servicePlan('auto', stopped), { candidates: [serviceCandidate()] });
  assert.equal(auto.ok, true, '可重写降级，不是硬拒');
  assert.deepEqual([...new Set(gAs(auto.downgrade))], ['GA6'], '实例级只报一条 GA6，不跟默认档比第二次');

  const none = checkStage2Plan(servicePlan('none', stopped), { candidates: [serviceCandidate()] });
  assert.equal(none.ok, true, '写 none 就过');
  assert.equal(none.hits.includes('GA6'), false, '合格不记 hit');
});

test('GA6 实例级：disable / mask / kill 同样要求 none；restart / start / enable 不被误压', () => {
  const withDetail = (detail) => ({
    plan: { steps: ['P1×service', 'P4×service'], files: [], estLines: 0 },
    intent: {
      impact: { paths: [], services: ['nginx'], remotes: [] },
      reversibility: 'manual',
      dryRun: { ok: true, detail },
      undo: { kind: '', ref: '', howto: 'systemctl start nginx' },
    },
  });
  for (const detail of ['systemctl --user disable nginx', 'systemctl mask nginx', 'systemctl kill -s TERM nginx']) {
    const verdict = checkStage2Plan(servicePlan('manual', withDetail(detail)), { candidates: [serviceCandidate()] });
    assert.ok(gAs(verdict.downgrade).includes('GA6'), detail);
    assert.match(verdict.downgrade.find((one) => one.ga === 'GA6').why, /档要写 none/);
  }

  for (const detail of ['systemctl restart nginx', 'systemctl start nginx', 'systemctl enable nginx']) {
    const verdict = checkStage2Plan(servicePlan('manual', withDetail(detail)), { candidates: [serviceCandidate()] });
    assert.equal(verdict.ok, true, `${detail} 保持原档位判定`);
    assert.equal(verdict.reject.some((one) => one.ga === 'GA6'), false, detail);
  }

  // 非 service 原语不受这条影响
  const inspectVerdict = checkStage2Plan(plan({
    why: 'systemctl stop nginx 之后再看日志',
    intent: {
      impact: { paths: ['lib/gate.js'], services: [], remotes: [] },
      reversibility: 'auto',
      undo: { kind: '', ref: '', howto: '' },
    },
  }), { candidates: [candidate()] });
  assert.equal(inspectVerdict.reject.some((one) => one.ga === 'GA6'), false, 'inspect 格不因文案里有 stop 被压档');
});

/* ── GA14：outbound 目标白名单 ──────────────────────────────────────── */

const outboundCandidate = () => candidate({
  id: 'C07',
  primitive: 'outbound',
  primitiveKey: 'outbound',
  objectKind: 'session',
  objectKey: 'session',
  material: '给用户发一句备份盘满了',
  defaults: { impact: 'outbound', reversibility: 'none' },
});

const outboundPlan = (target, over = {}) => plan({
  pick: 'C07',
  object: { kind: 'session', value: target, anchor: `${target}@2026-11-10T05:28:00Z` },
  evidence: [{ claim: '备份盘用了 92%', source: 'host_status', value: '36', at: '2026-11-10T05:28:00Z' }],
  plan: { steps: ['P1×session', 'P7×session'], files: [], estLines: 0 },
  intent: {
    impact: { paths: [], services: [], remotes: [] },
    reversibility: 'none',
    dryRun: { ok: true, detail: 'chat_recall 该会话' },
    undo: { kind: '', ref: '', howto: 'chat 补发一句更正，已发的那条收不回' },
  },
  ...over,
});

test('GA14：outboundTargets 空表时任何 outbound 方案都拒（没写目标也拒）', () => {
  const noTarget = checkStage2Plan(outboundPlan(''), { candidates: [outboundCandidate()] });
  assert.equal(noTarget.ok, false);
  assert.deepEqual(gAs(noTarget.reject), ['GA14']);
  assert.match(noTarget.reject[0].why, /outbound 目标不在白名单里/);
  assert.match(noTarget.reject[0].why, /没写目标/);
  assert.equal(noTarget.hits.includes('GA14'), true);

  const emptyAllow = checkStage2Plan(outboundPlan('c2c:abc123'), { candidates: [outboundCandidate()] });
  assert.deepEqual(gAs(emptyAllow.reject), ['GA14']);
  assert.match(emptyAllow.reject[0].why, /一律不许发/);

  const omitted = checkStage2Plan(outboundPlan('c2c:abc123'), { candidates: [outboundCandidate()], outboundTargets: [] });
  assert.deepEqual(gAs(omitted.reject), ['GA14']);
});

test('GA14：目标在白名单过；不在白名单拒；非 outbound 原语不受影响', () => {
  const allow = ['c2c:abc123', 'group:987654'];
  const pass = checkStage2Plan(outboundPlan('c2c:abc123'), { candidates: [outboundCandidate()], outboundTargets: allow });
  assert.equal(pass.ok, true, pass.reject.map((one) => one.why).join('；'));
  assert.equal(pass.hits.includes('GA14'), false);
  assert.equal(pass.allowDo, true);

  const outside = checkStage2Plan(outboundPlan('group:111111'), { candidates: [outboundCandidate()], outboundTargets: allow });
  assert.deepEqual(gAs(outside.reject), ['GA14']);
  assert.match(outside.reject[0].why, /group:111111/);

  // 目标大小写/空格不放过：原样比对（白名单里怎么写的就得怎么发）
  const spaced = checkStage2Plan(outboundPlan(' c2c:abc123 '), { candidates: [outboundCandidate()], outboundTargets: allow });
  assert.equal(spaced.ok, true, '两侧空格先 trim 再原样比');

  const inspect = checkStage2Plan(plan({ object: { kind: 'files', value: 'c2c:abc123', anchor: 'lib/gate.js:36' } }), {
    candidates: [candidate()],
    outboundTargets: [],
  });
  assert.equal(inspect.reject.some((one) => one.ga === 'GA14'), false, '非 outbound 原语不看白名单');
});

test('GA14：目标的第二来源是 intent.impact（object.value 空时）', () => {
  const planNoObject = outboundPlan('', {
    object: { kind: 'session', value: '', anchor: 'c2c:abc123@2026-11-10T05:28:00Z' },
    intent: {
      impact: { paths: [], services: [], remotes: [], targets: ['c2c:abc123'] },
      reversibility: 'none',
      dryRun: { ok: true, detail: 'chat_recall 该会话' },
      undo: { kind: '', ref: '', howto: 'chat 补发一句更正，已发的那条收不回' },
    },
  });
  const hit = checkStage2Plan(planNoObject, { candidates: [outboundCandidate()], outboundTargets: ['c2c:abc123'] });
  assert.equal(hit.ok, true, hit.reject.map((one) => one.why).join('；'));
});

test('GA14：gate 构造时的白名单与 checkPlan 的 opts 各自生效', async () => {
  const gateWithAllow = createGate({ outboundTargets: ['group:987654'] });
  const ok = await gateWithAllow.checkPlan(outboundPlan('group:987654'), { candidates: [outboundCandidate()] });
  assert.equal(ok.ok, true, ok.reject.map((one) => one.why).join('；'));
  assert.deepEqual(gateWithAllow.outboundTargets, ['group:987654']);

  const overridden = await gateWithAllow.checkPlan(outboundPlan('c2c:abc123'), {
    candidates: [outboundCandidate()],
    outboundTargets: ['c2c:abc123'],
  });
  assert.equal(overridden.ok, true, 'checkPlan 的 opts.outboundTargets 优先');

  const bare = await createGate().checkPlan(outboundPlan('c2c:abc123'), { candidates: [outboundCandidate()] });
  assert.deepEqual(gAs(bare.reject), ['GA14'], '不传白名单 = 空表 = 一律不许发');
  assert.deepEqual(createGate().outboundTargets, []);
});

/* ── GA15 / GA16：两段式结构 ────────────────────────────────────────── */

test('GA15：两步齐全（step1 三栏 + verdict=continue + step2.change + steps 里有 A）就过', () => {
  const ok = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.equal(ok.reject.length, 0, JSON.stringify(ok.reject));
  assert.equal(ok.hits.includes('GA15'), false);

  const noStep1 = checkStage2Plan(plan({ step1: undefined }), { candidates: [candidate()] });
  assert.deepEqual([...new Set(gAs(noStep1.downgrade))], ['GA15']);
  assert.match(noStep1.downgrade.find((one) => one.ga === 'GA15').why, /step1 要写 read/);

  const halfStep1 = checkStage2Plan(plan({ step1: { read: 'lib/gate.js:36', verdict: 'continue' } }), { candidates: [candidate()] });
  assert.deepEqual([...new Set(gAs(halfStep1.downgrade))], ['GA15'], 'abortIf 缺了也算结构不齐');

  const noStep2 = checkStage2Plan(plan({ step2: undefined }), { candidates: [candidate()] });
  assert.deepEqual([...new Set(gAs(noStep2.downgrade))], ['GA15']);
  assert.match(noStep2.downgrade.find((one) => one.ga === 'GA15').why, /没写 step2/);

  const emptyChange = checkStage2Plan(plan({ step2: { change: '  ', files: [], estLines: 0 } }), { candidates: [candidate()] });
  assert.deepEqual([...new Set(gAs(emptyChange.downgrade))], ['GA15']);
  assert.match(emptyChange.downgrade.find((one) => one.ga === 'GA15').why, /step2\.change 是空的/);

  // steps 里没有 A 那一步：读完要动，动的那一步得出现在 steps 里
  const noActionStep = checkStage2Plan(plan({ plan: { steps: ['P1×files'], files: [], estLines: 0 } }), { candidates: [candidate()] });
  assert.deepEqual([...new Set(gAs(noActionStep.downgrade))], ['GA15']);
  assert.match(noActionStep.downgrade.find((one) => one.ga === 'GA15').why, /A 是 edit-file/);
});

test('GA15：verdict=abort 是合法收工——step1 齐、step2 空着就行，写了第二步就拒', () => {
  const aborted = plan({
    step1: { read: 'lib/gate.js:36-70', verdict: 'abort', abortIf: '没有重复分支就 abort' },
    step2: undefined,
    idea: 'lib/gate.js 的重复分支上个提交已经清掉了', // 数字要有 evidence 出处，这里干脆不带数字
    object: null,
    evidence: [],
    plan: { steps: [], files: [], estLines: 0 },
  });
  const ok = checkStage2Plan(aborted, { candidates: [candidate()] });
  assert.equal(ok.ok, true, JSON.stringify(ok.reject));
  assert.equal(ok.allowDo, true, 'abort 的票不该带 action');

  const contradictory = checkStage2Plan(plan({
    pick: 'C01',
    step1: { read: 'lib/gate.js:36-70', verdict: 'abort', abortIf: '没有重复分支就 abort' },
  }), { candidates: [candidate()] });
  assert.deepEqual([...new Set(gAs(contradictory.downgrade))], ['GA15']);
  assert.match(contradictory.downgrade.find((one) => one.ga === 'GA15').why, /读了判断不动/);
});

test('GA15：step1.read 声称读过的路径，本拍 read 一次没碰就打回；不传 readPaths 时不判', () => {
  const HOME = '/home/julia';
  const GATE = `${HOME}/fatfish/plugins/dsh-ego/lib/gate.js`;

  // 相对 ↔ 绝对：plan 写 lib/gate.js，实际 read 记的是绝对路径
  const relative = checkStage2Plan(plan(), { candidates: [candidate()], readPaths: [GATE], home: HOME });
  assert.equal(relative.hits.includes('GA15'), false, JSON.stringify(relative.downgrade));

  // ~ 展开：plan 写 ~/…，实际 read 记的是绝对路径
  const tilde = checkStage2Plan(plan({ step1: { read: '~/.dsh/profiles/qqbot/cordis.patch.yml:679', verdict: 'continue', abortIf: 'x' } }), {
    candidates: [candidate()],
    readPaths: [`${HOME}/.dsh/profiles/qqbot/cordis.patch.yml`],
    home: HOME,
  });
  assert.equal(tilde.hits.includes('GA15'), false, JSON.stringify(tilde.downgrade));

  // 反过来：实际 read 记的是 ~/…，plan 写绝对路径
  const reversed = checkStage2Plan(plan({ step1: { read: `${HOME}/.dsh/profiles/qqbot/cordis.patch.yml`, verdict: 'continue', abortIf: 'x' } }), {
    candidates: [candidate()],
    readPaths: ['~/.dsh/profiles/qqbot/cordis.patch.yml'],
    home: HOME,
  });
  assert.equal(reversed.hits.includes('GA15'), false, JSON.stringify(reversed.downgrade));

  // 一处都没读过：按 GA15 既有风格打回重写（code=GA15，用满落 silent）
  const stale = checkStage2Plan(plan(), {
    candidates: [candidate()],
    readPaths: [`${HOME}/fatfish/plugins/dsh-ego/lib/proposer.js`],
    home: HOME,
  });
  const failed = stale.downgrade.find((one) => one.ga === 'GA15');
  assert.ok(failed, JSON.stringify(stale.downgrade));
  assert.equal(failed.code, 'GA15');
  assert.equal(failed.originalAction, 'silent');
  assert.match(failed.why, /read 一次都没碰过/);
  assert.match(failed.why, /实际读过：.*proposer\.js/);
  assert.equal(stale.ok, true, '可重写降级不是硬拒，跟其它 GA15 分支一致');

  // 一次 read 都没调（2026-11-21 那拍）：空集合照样打回
  const noRead = checkStage2Plan(plan(), { candidates: [candidate()], readPaths: [], home: HOME });
  assert.match(noRead.downgrade.find((one) => one.ga === 'GA15').why, /实际读过：一个文件都没读/);

  // step1.read 是一句话，写了文件 + grep 的目录：命中一处就放行（别把 grep 的路径当没读）
  const prose = checkStage2Plan(plan({
    step1: {
      read: `${HOME}/.dsh/profiles/qqbot/cordis.patch.yml（全文 1358 行读完）＋ grep ${HOME}/fatfish/plugins/dsh-price-clock 查 cheapWindows 默认值`,
      verdict: 'continue',
      abortIf: 'x',
    },
  }), {
    candidates: [candidate()],
    readPaths: [`${HOME}/.dsh/profiles/qqbot/cordis.patch.yml`],
    home: HOME,
  });
  assert.equal(prose.hits.includes('GA15'), false, JSON.stringify(prose.downgrade));

  // 不传 readPaths 时按调用侧口径决定（三档见 lib/gate.js 的 READ_EVIDENCE_MODES）：
  // 没写 readEvidence = 纯函数老口径 off，第三方老调用方行为不变
  const bare = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.equal(bare.hits.includes('GA15'), false);
  const explicitOff = checkStage2Plan(plan(), { candidates: [candidate()], readEvidence: 'off' });
  assert.equal(explicitOff.hits.includes('GA15'), false, 'off 显式回老行为');

  // missing（线上引擎 / replay 传的就是这一档）：没传 readPaths 判证据不足，不能当合格
  const missing = checkStage2Plan(plan(), { candidates: [candidate()], readEvidence: 'missing' });
  const missingFail = missing.downgrade.find((one) => one.ga === 'GA15');
  assert.ok(missingFail, JSON.stringify(missing.downgrade));
  assert.match(missingFail.why, /readPaths 缺失/);
  assert.match(missingFail.why, /证据不足/);
  assert.equal(missing.ok, true, '可重写降级，不是硬拒');
});

test('GA15：strict 档把「只靠记忆检索」的 step1.read 也判证据不足，但真读过可核路径照旧放行', () => {
  const HOME = '/home/julia';
  const GATE = `${HOME}/fatfish/plugins/dsh-ego/lib/gate.js`;
  // 2026-11-22 那 9 条提议的写法：step1.read 全是记忆检索，一个文件路径都认不出
  const memoryOnly = plan({
    step1: {
      read: 'memory_recall 两次：工单池盘点条目与 plans 目录盘点条目；这一拍没有 read 工具，一个文件都没打开',
      verdict: 'continue',
      abortIf: 'x',
    },
  });
  const missingMode = checkStage2Plan(memoryOnly, { candidates: [candidate()], readPaths: [], readEvidence: 'missing' });
  assert.equal(missingMode.hits.includes('GA15'), false, 'missing 只管 readPaths 缺失，认不出路径仍是 unsupported');
  assert.ok(missingMode.unsupported.some((one) => one.ga === 'GA15'), '老口径：记一条未核就放行');

  const strict = checkStage2Plan(memoryOnly, { candidates: [candidate()], readPaths: [], readEvidence: 'strict' });
  const strictFail = strict.downgrade.find((one) => one.ga === 'GA15');
  assert.ok(strictFail, JSON.stringify(strict.downgrade));
  assert.match(strictFail.why, /证据不足/);
  assert.equal(strictFail.code, 'GA15');
  assert.equal(strictFail.originalAction, 'silent', '用满重写次数落回原本的拒');

  // strict 不是一律拦：step1.read 认得出路径、本拍又真读过 → 放行
  const strictOk = checkStage2Plan(plan(), {
    candidates: [candidate()],
    readPaths: [GATE],
    home: HOME,
    readEvidence: 'strict',
  });
  assert.equal(strictOk.hits.includes('GA15'), false, JSON.stringify(strictOk.downgrade));
});

const SINGLE_CANDIDATE = (over = {}) => candidate({ primitive: 'inspect', motivation: 'hygiene', defaults: { impact: 'read', reversibility: 'auto' }, ...over });

const singlePlan = (over = {}) => plan({
  pick: 'C01',
  step1: { read: 'lib/gate.js 全文件', verdict: 'continue', abortIf: '没有可疑分支就 abort' },
  step2: undefined,
  idea: 'lib/gate.js 里有两处相似分支，值得先读一遍看清楚',
  object: null,
  evidence: [],
  plan: { steps: ['P1×files'], files: [], estLines: 0 },
  intent: { impact: { paths: [], services: [], remotes: [] }, reversibility: 'auto', undo: { kind: '', ref: '', howto: '只读，无改动：grep 一遍 lib/gate.js 复核' } },
  ...over,
});

test('GA15：单段读（action 为空）动机是 hygiene/status、全拍一格、带产出才过', () => {
  const ok = checkStage2Plan(singlePlan(), { candidates: [SINGLE_CANDIDATE()] });
  assert.equal(ok.ok, true, JSON.stringify(ok.reject));

  const wrongMotivation = checkStage2Plan(singlePlan(), { candidates: [SINGLE_CANDIDATE({ motivation: 'backlog' })] });
  assert.deepEqual([...new Set(gAs(wrongMotivation.downgrade))], ['GA15']);
  assert.match(wrongMotivation.downgrade.find((one) => one.ga === 'GA15').why, /单段只许 hygiene \/ status/);

  // 全拍两格单段：count 从整张候选表数出来
  const twoSingles = checkStage2Plan(singlePlan(), {
    candidates: [SINGLE_CANDIDATE(), SINGLE_CANDIDATE({ id: 'C02', read: cell('inspect', 'session') })],
  });
  assert.deepEqual([...new Set(gAs(twoSingles.downgrade))], ['GA15']);
  assert.match(twoSingles.downgrade.find((one) => one.ga === 'GA15').why, /全拍只许一格/);

  // 也可以由 index.js 先算好传进来
  const counted = checkStage2Plan(singlePlan(), { candidates: [SINGLE_CANDIDATE()], singleReadCount: 2 });
  assert.match(counted.downgrade.find((one) => one.ga === 'GA15').why, /全拍只许一格/);

  const wroteStep2 = checkStage2Plan(singlePlan({ step2: { change: '顺手改掉', files: [], estLines: 0 } }), { candidates: [SINGLE_CANDIDATE()] });
  assert.deepEqual([...new Set(gAs(wroteStep2.downgrade))], ['GA15']);
  assert.match(wroteStep2.downgrade.find((one) => one.ga === 'GA15').why, /单段读候选不许写 step2/);

  const noIdea = checkStage2Plan(singlePlan({ idea: '' }), { candidates: [SINGLE_CANDIDATE()] });
  assert.deepEqual([...new Set(gAs(noIdea.downgrade))], ['GA15']);
  assert.match(noIdea.downgrade.find((one) => one.ga === 'GA15').why, /idea 不许空/);

  const noSteps = checkStage2Plan(singlePlan({ plan: { steps: [], files: [], estLines: 0 } }), { candidates: [SINGLE_CANDIDATE()] });
  assert.deepEqual([...new Set(gAs(noSteps.downgrade))], ['GA15']);

  const emptyHowto = checkStage2Plan(singlePlan({ intent: { impact: { paths: [], services: [], remotes: [] }, reversibility: 'auto', undo: { kind: '', ref: '', howto: '…' } } }), { candidates: [SINGLE_CANDIDATE()] });
  assert.deepEqual([...new Set(gAs(emptyHowto.downgrade))], ['GA15']);
  assert.match(emptyHowto.downgrade.find((one) => one.ga === 'GA15').why, /复核方式/);
});

test('GA15：没有 read/action 两栏的候选不再兼容，按结构缺失打回', () => {
  const legacy = {
    id: 'C01',
    primitive: 'inspect',
    primitiveKey: 'inspect',
    objectKind: 'files',
    objectKey: 'files',
    material: 'x',
    motivation: 'hygiene',
    defaults: { impact: 'read', reversibility: 'auto' },
  };
  const verdict = checkStage2Plan(plan(), { candidates: [legacy] });
  assert.ok(verdict.downgrade.some((one) => one.ga === 'GA15'), '平铺候选当成单段读会跟写 step2 自相矛盾，必须打回');
  assert.match(verdict.downgrade.find((one) => one.ga === 'GA15').why, /单段读候选不许写 step2/);
  assert.equal(verdict.unsupported.some((one) => one.ga === 'GA15'), false, '不再记 unsupported 装没看见');
});

test('GA16：读格原语不是只读的、或 steps 第一步就是动作 → 拒', () => {
  const ok = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.equal(ok.hits.includes('GA16'), false);

  const badRead = checkStage2Plan(plan(), { candidates: [candidate({ read: cell('edit-file', 'files'), action: cell('edit-file', 'files') })] });
  assert.deepEqual([...new Set(gAs(badRead.downgrade))], ['GA16']);
  assert.match(badRead.downgrade.find((one) => one.ga === 'GA16').why, /不是只读原语/);

  const actionFirst = checkStage2Plan(plan({ plan: { steps: ['P2×files', 'P1×files'], files: [], estLines: 0 } }), { candidates: [candidate()] });
  assert.deepEqual([...new Set(gAs(actionFirst.downgrade))], ['GA16']);
  assert.match(actionFirst.downgrade.find((one) => one.ga === 'GA16').why, /读的那一步要排在动前面/);

  // 外部检索是只读的，可以当读格
  const externalRead = checkStage2Plan(plan({
    object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:36' },
    step1: { read: '上游文档的同类实现', verdict: 'continue', abortIf: '上游没这写法就 abort' },
  }), { candidates: [candidate({ read: cell('external-research', 'external-doc') })] });
  assert.equal(externalRead.hits.includes('GA16'), false, JSON.stringify(externalReject(externalRead)));
});

const externalReject = (verdict) => verdict.reject.map((one) => one.why).join('；');

test('GA17：素材没写文件锚点时判不了，收进 unsure 交给 arbiter', () => {
  const verdict = checkStage2Plan(plan(), { candidates: [candidate()] });
  const note = verdict.unsure.find((one) => one.ga === 'GA17');
  assert.ok(note, 'GA17 要在 unsure 里露个脸，别假装核过');
  assert.match(note.why, /没有可认的文件锚点/);
  assert.match(note.subject, /素材/);
  assert.equal(verdict.downgrade.some((one) => one.ga === 'GA17'), false, '判不了时不许硬判');
});

test('GA17：素材有文件锚点时，把锚点和第一步落点一起交给 arbiter', () => {
  const withFile = candidate({ material: 'lib/gate.js 的十七关注释跟实现对不上' });
  const matched = checkStage2Plan(plan({
    step1: { read: 'lib/gate.js:36-70 的十七关', verdict: 'continue', abortIf: '没有分叉就 abort' },
    object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:36' },
  }), { candidates: [withFile] });
  const note = matched.unsure.find((one) => one.ga === 'GA17');
  assert.ok(note, '锚点对不对不是代码能判的');
  assert.match(note.why, /素材里有文件锚点 lib\/gate\.js/);
  assert.match(note.subject, /step1\.read=lib\/gate\.js:36-70/);
  assert.equal(matched.downgrade.some((one) => one.ga === 'GA17'), false, '不许硬判对不上');

  const missed = checkStage2Plan(plan({
    step1: { read: 'route.js:12 的开票链路', verdict: 'continue', abortIf: '没有分支就 abort' },
    object: { kind: 'files', value: 'lib/route.js', anchor: 'lib/route.js:12' },
    plan: { steps: ['P1×files'], files: ['lib/route.js'], estLines: 0 },
  }), { candidates: [withFile] });
  const mismatch = missed.unsure.find((one) => one.ga === 'GA17');
  assert.ok(mismatch, '素材指向 gate.js、第一步读 route.js，事实要交 arbiter 看');
  assert.match(mismatch.subject, /lib\/route\.js/);
  assert.equal(missed.downgrade.some((one) => one.ga === 'GA17'), false);
});

/* ── 结构与接线 ────────────────────────────────────────────────────── */

test('gate 不 import fs/path/os：读盘那半只从 deps 进来', () => {
  const source = fs.readFileSync(new URL('../lib/gate.js', import.meta.url), 'utf8');
  assert.equal(/from 'node:fs/.test(source), false);
  assert.equal(/from 'node:path/.test(source), false);
  assert.equal(/from 'node:os'/.test(source), false);
});

test('gate 的原语别名表与 grid.js 的 PRIMITIVES 一致', () => {
  // P1..P9 的序号与 id 映射：拿 PRIMITIVES 的顺序逐条对
  PRIMITIVES.forEach((p, i) => {
    const verdict = checkStage2Plan(plan({ plan: { steps: [`P${i + 1}×files`], files: [], estLines: 0 } }), {
      candidates: [candidate({ objectKind: 'files' })],
      pairs: new Set(), // 空矩阵：解析成功就只会报「不在配对矩阵里」
    });
    // 只验解析：矩阵空集时报 GA2，说明这一步解析出了原语而不是「认不出」
    const why = verdict.reject.map((one) => one.why).join('');
    assert.equal(why.includes('认不出是哪个原语'), false, `P${i + 1} 没解析成 ${p.id}`);
  });
  assert.deepEqual(
    OBJECT_KINDS.map((one) => one.id).sort(),
    ['config', 'external-doc', 'external-repo', 'files', 'memory', 'plan', 'service', 'session', 'ticket'],
  );
});

test('index.js 的接线：deps 注入一处、gate.checkPlan 一处、ga_hits 一处', () => {
  const index = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8')].join('\n');
  assert.equal((index.match(/createGate\(/g) ?? []).length, 1);
  assert.equal((index.match(/gate\.checkPlan\(/g) ?? []).length, 1, '方案校验只有一处');
  assert.equal((index.match(/ga_hits:/g) ?? []).length, 1, 'ga_hits 每拍一行');
  assert.equal(index.includes('checkExists: (object) => checkExistsFrom('), true, '真实现从 index 注入');
  assert.equal(index.includes('checkFileLine: (anchor) => checkFileLineFrom('), true);
  assert.equal(index.includes('PLUGIN_DIR'), true, '相对路径先按插件目录解析');
  assert.equal(index.includes('REPO_ROOT'), true, '查不到再按仓库根解析');
  assert.ok(index.indexOf('gate.checkPlan(') < index.lastIndexOf('rememberCombo(candidate);'), '校验在记账之前');
  assert.equal(index.includes('GA1~GA20'), true, '方案校验的注释跟着加到 GA20（两段式两条 + solution 三道）');
  assert.equal(index.includes('outboundTargets: normalizeOutboundTargets(cfg.outboundTargets)'), true, 'GA14 白名单从配置接到 gate');
  assert.equal(index.includes('normalizeOutboundTargets'), true, 'gate.js 的归一函数要在 index 里用上，不另写一份');
});
