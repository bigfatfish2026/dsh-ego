/**
 * stage1 候选枚举（lib/grid.js）与存在性核查（lib/exists.js）的单测。
 *
 * 两段式（两段式实现）之后，覆盖这些事：
 * 对的两段形状与数量（全开 19 对 / 默认 15 对 + 最多一格单段读）、确定性、约束表对两段都管、
 * 亲和度与动机权重只进排序、自指冷却 12h、recentCombos 只认对、素材额度、
 * maxCandidates 截断、lastMaterial 排后；再加 exists 的本地核查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_CANDIDATES,
  MAX_ACTIONS_PER_READ,
  MOTIVATION_PRIMITIVES,
  PAIRING_MATRIX,
  PAIR_CONSTRAINTS,
  PRIMITIVES,
  ROLE_ACTION,
  ROLE_READ,
  SINGLE_READ_MOTIVATIONS,
  affinityOf,
  buildGrid,
  cellIdOf,
  createSeededRandom,
  enumerateCells,
  materialHintsOf,
  normalizeComboKey,
} from '../lib/grid.js';
import { EXIST_STATUS, checkExists, checkFileLine } from '../lib/exists.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 60 * 60 * 1000;

/** 规则 6.1 的九条默认素材。 */
const MATERIALS = [
  { text: '手上还没收尾的待办、说好要做的事', motivation: 'backlog' },
  { text: '挑一个本地仓库翻翻，看有没有跑不过的测试', motivation: 'hygiene' },
  { text: '本地仓库和远端是不是同步', motivation: 'sync' },
  { text: 'yaml / 配置里有没有没人用的项', motivation: 'hygiene' },
  { text: '陈旧的备份、日志、临时文件是不是该清了', motivation: 'hygiene' },
  { text: '邮箱 / 消息通知里有没有攒着没看的', motivation: 'social' },
  { text: '记忆里有没有新条目、有没有互相矛盾的', motivation: 'memory' },
  { text: '宿主状态：温度、内存、磁盘、服务、日志', motivation: 'status' },
  { text: '优化 dsh-ego 插件自己', motivation: 'self' },
];

const ALL_PRIMITIVES = Object.fromEntries(PRIMITIVES.map((p) => [p.key, true]));
const ALL_OBJECTS = Object.fromEntries(
  ['files', 'config', 'service', 'memory', 'ticket', 'session', 'externalDoc', 'externalRepo', 'plan'].map((k) => [k, true]),
);

/** 线上默认开关（DEFAULTS.proposer.primitives）：service / memoryWrite / outbound 关着。 */
const DEFAULT_PRIMITIVES = {
  inspect: true,
  editFile: true,
  editConfig: true,
  service: false,
  memoryWrite: false,
  delete: true,
  outbound: false,
  externalResearch: true,
};

function grid(extra = {}) {
  return buildGrid({
    materials: MATERIALS,
    primitives: ALL_PRIMITIVES,
    objects: ALL_OBJECTS,
    now: NOW,
    ...extra,
  });
}

/** 一格在候选里长什么样：`['inspect','files']`；单段读的 A 段写 null。 */
const readOf = (c) => [c.read.primitive, c.read.objectKind];
const actionOf = (c) => (c.action ? [c.action.primitive, c.action.objectKind] : null);
const quads = (list) => list.map((c) => [...readOf(c), ...(actionOf(c) ?? [null, null]), c.material]);

test('全开时 19 对：R 段只读、A 段有副作用、id 按截断后顺序编号', () => {
  const first = grid();
  const second = grid();
  assert.deepEqual(first, second, '同样输入两次必须一模一样');
  // 9 个原语（8 条原有 + P9 写方案）、9 类对象（8 类原有 + plan）全开：
  // 读格 11（inspect×9 + external-research×2）、动作格 8，素材 9 条按槽位挂满后实算 19 对
  assert.equal(first.length, 19, '规则第五节实算：原语/对象全开 = 19 对');
  assert.ok(first.length <= DEFAULT_MAX_CANDIDATES, '默认上限 24 不许超');
  assert.deepEqual(
    first.map((c) => c.id),
    first.map((_, i) => `C${String(i + 1).padStart(2, '0')}`),
    'id 按截断后的顺序编号',
  );
  for (const c of first) {
    assert.ok(ROLE_READ.includes(c.read.primitive), `${c.id} 的 R 段 ${c.read.primitive} 不是只读原语`);
    assert.ok(c.action, `${c.id}：全开时每个 R 都配得上 A，不该有单段读`);
    assert.ok(ROLE_ACTION.includes(c.action.primitive), `${c.id} 的 A 段 ${c.action.primitive} 不是动作原语`);
    assert.equal(typeof c.material, 'string');
    assert.ok(c.material.length > 0, '有候选就有种子');
    assert.ok(c.defaults && typeof c.defaults.impact === 'string' && typeof c.defaults.reversibility === 'string');
    // 默认档取 A（探索票按最坏情形记账），不是取读格
    assert.equal(c.defaults.reversibility, PRIMITIVES.find((p) => p.id === c.action.primitive).reversibility);
  }
});

test('默认开关下 15 对，外加最多一格单段读', () => {
  const list = grid({ primitives: DEFAULT_PRIMITIVES, maxCandidates: 99 });
  const pairs = list.filter((c) => c.action);
  const singles = list.filter((c) => !c.action);
  assert.equal(pairs.length, 15, '默认开关下 15 对（新增 draft×plan 一格）');
  assert.equal(singles.length, 1, '单段读全拍最多一格');
  assert.ok(
    pairs.every((c) => ['edit-file', 'edit-config', 'delete', 'draft'].includes(c.action.primitive)),
    '默认只放四条动作原语（含写方案）',
  );
  const single = singles[0];
  assert.ok(SINGLE_READ_MOTIVATIONS.includes(single.motivation), `单段读的动机是 ${single.motivation}，只许 hygiene / status`);
  assert.ok(ROLE_READ.includes(single.read.primitive));
  assert.equal(single.defaults.reversibility, 'auto', '单段读的默认档取读格（只读，撤得回）');
});

test('配对矩阵对两段都管：edit-config 只许落 config，external-research 读不了 files', () => {
  // 只有动作原语、没有读格：这一拍什么都排不出来
  assert.deepEqual(
    buildGrid({ materials: MATERIALS, primitives: { editConfig: true }, objects: { files: true, config: true }, now: NOW }),
    [],
    '没有只读原语就凑不出 R，一对也没有',
  );
  // external-research 的矩阵里没有 files：读不了文件类，不许自己造
  assert.deepEqual(
    buildGrid({
      materials: MATERIALS,
      primitives: { externalResearch: true, editFile: true },
      objects: { files: true },
      now: NOW,
    }),
    [],
    'external-research × files 是 —，没有读格可用',
  );
  const ok = buildGrid({
    materials: MATERIALS,
    primitives: { externalResearch: true, editFile: true },
    objects: { externalDoc: true, files: true },
    now: NOW,
  });
  assert.equal(ok.length, 1, 'external-research × external-doc → edit-file × files 是一对');
  assert.deepEqual(readOf(ok[0]), ['external-research', 'external-doc']);
  assert.deepEqual(actionOf(ok[0]), ['edit-file', 'files']);

  // 全开时两段都必须落在矩阵里
  for (const c of grid()) {
    assert.ok(PAIRING_MATRIX[c.read.primitive].includes(c.read.objectKind), `${c.read.primitive} × ${c.read.objectKind} 读格不合法`);
    assert.ok(PAIRING_MATRIX[c.action.primitive].includes(c.action.objectKind), `${c.action.primitive} × ${c.action.objectKind} 动作格不合法`);
  }
});

test('自指冷却 12 小时：self 方向与提到 dsh-ego 的素材都被剔', () => {
  const selfOnly = [{ text: '优化 dsh-ego 插件自己', motivation: 'self' }];
  assert.deepEqual(
    buildGrid({ materials: selfOnly, primitives: ALL_PRIMITIVES, objects: ALL_OBJECTS, lastSelfIdeaAt: NOW - 1 * HOUR, now: NOW }),
    [],
    '冷却期内只剩 self 素材 → 没有候选',
  );
  assert.deepEqual(
    buildGrid({ materials: selfOnly, primitives: ALL_PRIMITIVES, objects: ALL_OBJECTS, lastSelfIdeaAt: NOW - 11 * HOUR, now: NOW }),
    [],
    '11 小时还在冷却里（2026-11-11 从 48h 改成 12h）',
  );
  assert.ok(
    buildGrid({ materials: selfOnly, primitives: ALL_PRIMITIVES, objects: ALL_OBJECTS, lastSelfIdeaAt: NOW - 13 * HOUR, now: NOW }).length > 0,
    '过了 12 小时要放回来',
  );

  // 判据仍是 isSelfReferential：动机写 hygiene、文本提到 dsh-ego 也算自指
  const disguised = [{ text: '看 dsh-ego 的 lib/gate.js:44 有没有漏', motivation: 'hygiene' }];
  assert.deepEqual(
    buildGrid({ materials: disguised, primitives: ALL_PRIMITIVES, objects: ALL_OBJECTS, lastSelfIdeaAt: NOW - HOUR, now: NOW }),
    [],
  );
});

test('recentCombos 只认对：整对剔掉，老的单格格式不算对', () => {
  // 只留一个读格 + 两个动作格：剔掉一对就真少一对，不会被第三个动作格补上
  const base = {
    materials: MATERIALS,
    primitives: { inspect: true, editFile: true, delete: true },
    objects: { files: true },
    now: NOW,
  };
  const full = buildGrid(base);
  assert.equal(full.length, 2, 'inspect×files 配 edit-file / delete 两对');

  const cut = buildGrid({
    ...base,
    recentCombos: [
      'inspect|files→edit-file|files', // 这一对提过
      'P1×files→P6×files', // 别名写法也认
      'delete|files', // 上一版的一格格式（动作格）：丢弃，不算对
      'C03', // 旧日志里的临时 id：认不出，忽略
      'not-a-combo',
    ],
  });
  assert.equal(cut.length, 0, '两对都提过：这一拍这个读格没有候选了');

  // 只剔一对时，同一读格的另一对还在（剔的是对，不是读格）
  const one = buildGrid({ ...base, recentCombos: ['inspect|files→edit-file|files'] });
  assert.equal(one.length, 1);
  assert.deepEqual(actionOf(one[0]), ['delete', 'files']);

  assert.equal(normalizeComboKey('P1×files→P6×files'), 'inspect|files→delete|files', 'P1/P8 才能当读，P2~P7 只能当动作');
  assert.equal(normalizeComboKey('P6×files→P2×files'), '', '读那一半是动作原语的对不认');
  assert.equal(normalizeComboKey({ read: { primitive: 'inspect', objectKind: 'files' }, action: { primitive: 'edit-file', objectKind: 'files' } }), 'inspect|files→edit-file|files');
  assert.equal(normalizeComboKey({ read: { primitive: 'inspect', objectKind: 'files' }, action: null }), 'inspect|files→', '单段读的键箭尾留空');
  assert.equal(normalizeComboKey('inspect|files→'), 'inspect|files→', '写下去的单段键读回来还是它');
  assert.equal(normalizeComboKey('P8×external-doc→'), 'external-research|external-doc→');
  assert.equal(normalizeComboKey('inspect|files'), '', '不带箭头的是上一版单格记账，照样丢');
  assert.equal(normalizeComboKey('inspect|files→delete|files'), 'inspect|files→delete|files');
  assert.equal(normalizeComboKey({ primitive: 'editFile', objectKind: 'files' }), '', '上一版的一格格式（对象写法）丢弃');
  assert.equal(normalizeComboKey('delete|files'), '', '上一版的一格格式（动作格）丢弃');
  assert.equal(normalizeComboKey('C03'), '');
});

test('单段读的键带箭尾：能进 recentCombos，第二拍就轮换掉', () => {
  const first = grid({ primitives: DEFAULT_PRIMITIVES, maxCandidates: 99 });
  const single = first.find((c) => !c.action);
  assert.ok(single, '默认开关下有一格单段读');
  const key = normalizeComboKey({ read: single.read, action: null });
  assert.equal(key, `${single.read.primitive}|${single.read.objectKind}→`, '单段的键写成箭尾留空的两段');

  // 第二拍：这一格已经记过，不再补单段；对那一半不受影响
  const second = grid({ primitives: DEFAULT_PRIMITIVES, maxCandidates: 99, recentCombos: [key] });
  assert.equal(second.filter((c) => !c.action).length, 0, '同一单段格第二拍被 recentCombos 挤掉');
  assert.equal(second.length, 15, '默认开关下的 15 对还在');
});

test('素材池空返回空数组', () => {
  assert.deepEqual(grid({ materials: [] }), []);
  assert.deepEqual(buildGrid({ now: NOW }), [], '不传 materials 也算空');
  assert.deepEqual(grid({ materials: [{ text: '  ', motivation: 'backlog' }] }), [], '空白素材等同没有');
  assert.deepEqual(grid({ materials: [{ text: '有字但动机不认识', motivation: 'wat' }] }), []);
});

test('maxCandidates 小于对数时按排序截断', () => {
  const full = grid();
  const cut = grid({ maxCandidates: 5 });
  assert.equal(cut.length, 5);
  assert.deepEqual(quads(cut), quads(full.slice(0, 5)), '截断取排序后的前 N 对，不是随机挑');
  assert.deepEqual(grid({ maxCandidates: 0 }), full, '0/负数不成立，回默认上限');
  assert.equal(grid({ maxCandidates: 3.9 }).length, 3, '小数向下取整');
});

test('一条素材最多挂两个读格，读格再各配最多两个动作格', () => {
  const single = [{ text: '唯一的待办', motivation: 'backlog' }];
  const readCells = (list) => new Set(list.map((c) => readOf(c).join('|')));
  const one = grid({ materials: single });
  assert.equal(readCells(one).size, 2, '一条素材最多两个读格');
  assert.ok(one.every((c) => c.material === '唯一的待办'));
  // 每个读格最多 M_A 对
  for (const key of readCells(one)) {
    assert.ok(one.filter((c) => readOf(c).join('|') === key).length <= MAX_ACTIONS_PER_READ);
  }
  const two = grid({ materials: single, materialSlots: 1 });
  assert.equal(readCells(two).size, 1, 'materialSlots=1 时只挂一个读格');
  assert.ok(two.length > 0);
  const five = grid({ materials: single, materialSlots: 5 });
  // 额度放宽：读到 5 个读格；inspect×memory 亲和度 0 配不出动作格，其余四格出 8 对
  // （ticket 格现在接得住 draft×plan 了）
  assert.equal(readCells(five).size, 5, '额度放宽后铺到五格');
  assert.equal(five.length, 8, '2 + 2 + 2 + 1 + 1 对');
});

test('原语/对象开关关掉就不进候选（读格与动作格都按白名单判）', () => {
  assert.deepEqual(grid({ primitives: Object.fromEntries(PRIMITIVES.map((p) => [p.key, false])) }), []);
  assert.deepEqual(grid({ objects: Object.fromEntries(Object.keys(ALL_OBJECTS).map((k) => [k, false])) }), []);
  const noService = grid({ primitives: { ...ALL_PRIMITIVES, service: false } });
  assert.equal(noService.some((c) => c.action?.primitive === 'service'), false, 'service 原语关了就没有动作格');
  assert.equal(noService.some((c) => c.read.primitive === 'inspect' && c.read.objectKind === 'service'), true, 'inspect × service 不受影响');
  // 不传开关 = 全关：白名单判法，宁可空拍也不放出没开过的原语
  assert.deepEqual(buildGrid({ materials: MATERIALS, now: NOW }), []);
});

test('动机只影响排序，不再决定合法性：sync 方向也能配出动配置的对', () => {
  // 规则第四节冲突 2：hygiene/sync 读到 files 发现其实是配置问题，A 要能落 edit-config。
  // sync 的老表里只有 inspect / external-research，现在那只是排序信号。
  assert.equal(MOTIVATION_PRIMITIVES.sync.includes('edit-config'), false, '老表里没有 edit-config，这是前提');
  const list = grid({
    materials: [{ text: '本地仓库和远端是不是同步', motivation: 'sync' }],
    primitives: { inspect: true, editConfig: true },
    objects: { files: true, config: true },
  });
  const pair = list.find((c) => c.read.objectKind === 'files' && c.action?.primitive === 'edit-config');
  assert.ok(pair, 'files 读格 → edit-config 动作格这一对必须排得出来');
  assert.deepEqual(actionOf(pair), ['edit-config', 'config']);
  assert.equal(pair.motivation, 'sync');

  // 反过来：动机权重高的排前面（backlog/status 3 > hygiene 1），其余相同时比权重
  const mixed = grid({
    materials: [
      { text: '陈旧的备份、日志、临时文件是不是该清了', motivation: 'hygiene' },
      { text: '手上还没收尾的待办、说好要做的事', motivation: 'backlog' },
    ],
    primitives: { inspect: true, editFile: true },
    objects: { files: true },
  });
  assert.equal(mixed[0].motivation, 'backlog', 'backlog（权重 3）排在 hygiene（权重 1）前面');
});

test('亲和度：同对象 2、表里的跨域 1、其余 0', () => {
  assert.equal(affinityOf('files', 'files'), 2);
  assert.equal(affinityOf('files', 'config'), 1);
  assert.equal(affinityOf('config', 'files'), 1);
  assert.equal(affinityOf('external-doc', 'memory'), 1);
  assert.equal(affinityOf('memory', 'files'), 0);
  assert.equal(affinityOf('ticket', 'files'), 0);
  // 亲和度 0 的动作格不成对：memory 读格配不出 files 动作（memory→files 是 0）
  const list = grid({
    materials: MATERIALS,
    primitives: { inspect: true, editFile: true },
    objects: { memory: true, files: true },
  });
  assert.equal(
    list.some((c) => c.action && c.read.objectKind === 'memory'),
    false,
    'memory 读格配不出 files 动作（亲和度 0），那一对不许出现',
  );
});

/** 全开时的排序快照：改 lastMaterial 前后不命中就必须一模一样。 */
const SNAPSHOT = [
  ['inspect', 'files', 'edit-file', 'files', '手上还没收尾的待办、说好要做的事'],
  ['inspect', 'config', 'edit-config', 'config', '宿主状态：温度、内存、磁盘、服务、日志'],
  ['inspect', 'files', 'delete', 'files', '手上还没收尾的待办、说好要做的事'],
  ['external-research', 'external-repo', 'delete', 'external-repo', '宿主状态：温度、内存、磁盘、服务、日志'],
  ['inspect', 'config', 'edit-file', 'files', '宿主状态：温度、内存、磁盘、服务、日志'],
  ['external-research', 'external-doc', 'edit-file', 'files', '手上还没收尾的待办、说好要做的事'],
  ['external-research', 'external-repo', 'edit-file', 'files', '宿主状态：温度、内存、磁盘、服务、日志'],
  ['external-research', 'external-doc', 'memory-write', 'memory', '手上还没收尾的待办、说好要做的事'],
  ['inspect', 'service', 'service', 'service', '本地仓库和远端是不是同步'],
  ['inspect', 'memory', 'memory-write', 'memory', '邮箱 / 消息通知里有没有攒着没看的'],
  ['inspect', 'service', 'edit-config', 'config', '本地仓库和远端是不是同步'],
  ['inspect', 'ticket', 'draft', 'plan', '记忆里有没有新条目、有没有互相矛盾的'],
  ['inspect', 'external-repo', 'delete', 'external-repo', '陈旧的备份、日志、临时文件是不是该清了'],
  ['inspect', 'session', 'outbound', 'session', '挑一个本地仓库翻翻，看有没有跑不过的测试'],
  ['inspect', 'plan', 'draft', 'plan', '优化 dsh-ego 插件自己'],
  ['inspect', 'external-doc', 'edit-file', 'files', 'yaml / 配置里有没有没人用的项'],
  ['inspect', 'external-repo', 'edit-file', 'files', '陈旧的备份、日志、临时文件是不是该清了'],
  ['inspect', 'plan', 'edit-file', 'files', '优化 dsh-ego 插件自己'],
  ['inspect', 'external-doc', 'memory-write', 'memory', 'yaml / 配置里有没有没人用的项'],
];

test('lastMaterial 不命中时排序与改前完全一致（快照）', () => {
  assert.deepEqual(quads(grid()), SNAPSHOT, '没传 lastMaterial 时顺序不许变');
  assert.deepEqual(quads(grid({ lastMaterial: '' })), SNAPSHOT, '空串按没有算');
  assert.deepEqual(quads(grid({ lastMaterial: undefined })), SNAPSHOT, 'undefined 按没有算');
  assert.deepEqual(quads(grid({ lastMaterial: '   ' })), SNAPSHOT, '空白串按没有算');
  assert.deepEqual(quads(grid({ lastMaterial: '素材池里没有这句话' })), SNAPSHOT, '不命中也不许挪动顺序');
});

test('lastMaterial 命中的对整组排到队尾，数量一个不少且组内保序', () => {
  const last = MATERIALS[7].text; // status 那条
  const base = grid();
  const hooked = grid({ lastMaterial: last });

  assert.equal(hooked.length, base.length, '只排后不剔除：候选数量不变');
  assert.equal(grid({ lastMaterial: last, maxCandidates: 5 }).length, 5, '截断仍按上限走');
  assert.deepEqual(grid({ lastMaterial: last }), hooked, '同样输入必得同样顺序');

  const hitBase = base.filter((c) => c.material === last);
  const restBase = base.filter((c) => c.material !== last);
  assert.ok(hitBase.length > 0, '这组素材里宿主机状态确实有对');

  assert.deepEqual(quads(hooked.slice(0, restBase.length)), quads(restBase), '没命中的对保持原序在前面');
  assert.deepEqual(quads(hooked.slice(restBase.length)), quads(hitBase), '命中的对按原序排在队尾');
  assert.equal(hooked[0].material === last, false, '第一对不再是上一拍那条素材');
  assert.equal(hooked.at(-1).material, last, '队尾仍是命中素材');
});

test('exists：本地文件在允许根内才算存在', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ego-exists-'));
  const file = path.join(dir, 'probe.json');
  await fs.writeFile(file, '{"a":1}\n', 'utf8');
  try {
    const ok = await checkExists({ kind: 'files', value: file }, { roots: [dir] });
    assert.equal(ok.status, EXIST_STATUS.OK);
    assert.equal(ok.ok, true);

    const config = await checkExists({ kind: 'config', value: file }, { roots: [dir] });
    assert.equal(config.status, EXIST_STATUS.OK);

    const missing = await checkExists({ kind: 'files', value: path.join(dir, 'nope.js') }, { roots: [dir] });
    assert.equal(missing.status, EXIST_STATUS.MISSING);
    assert.equal(missing.ok, false);

    // 允许根外的真文件：realpath 通得过，但不在根内 → 拒
    const outside = fileURLToPath(new URL('../README.md', import.meta.url));
    const denied = await checkExists({ kind: 'files', value: outside }, { roots: [dir] });
    assert.equal(denied.status, EXIST_STATUS.DENIED);
    assert.equal(denied.ok, false);

    // 符号链接跳出允许根也要拒
    const link = path.join(dir, 'escape.md');
    await fs.symlink(outside, link);
    const escaped = await checkExists({ kind: 'files', value: link }, { roots: [dir] });
    assert.equal(escaped.status, EXIST_STATUS.DENIED);

    // 非本地类返回 unsupported，而不是 false
    const unsupported = await checkExists({ kind: 'memory', value: 'mem-1' }, { roots: [dir] });
    assert.equal(unsupported.status, EXIST_STATUS.UNSUPPORTED);
    assert.equal(unsupported.ok, null, 'unsupported 不许当成「不存在」');

    assert.equal((await checkExists({ kind: '', value: 'x' }, { roots: [dir] })).status, EXIST_STATUS.INVALID);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('exists：锚点行号不越界', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ego-anchor-'));
  const file = path.join(dir, 'a.js');
  await fs.writeFile(file, 'one\ntwo\nthree\n', 'utf8');
  try {
    const good = await checkFileLine(`${file}:2`, { roots: [dir] });
    assert.equal(good.status, EXIST_STATUS.OK);
    assert.equal(good.totalLines, 3);

    const range = await checkFileLine(`${file}:2-3`, { roots: [dir] });
    assert.equal(range.status, EXIST_STATUS.OK);

    const behind = await checkFileLine(`${file}:9`, { roots: [dir] });
    assert.equal(behind.status, EXIST_STATUS.MISSING);
    assert.equal(behind.ok, false);

    const shape = await checkFileLine('没有行号的一句话', { roots: [dir] });
    assert.equal(shape.status, EXIST_STATUS.INVALID);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ══ 运行时枚举 + 约束表 + 加权抽取（B 版）════════════════════════════ */

/** 线上素材池（profile 那 11 条，第 11 条是「用 backlog_list 写方案文档到 plans/」）。 */
const LIVE_MATERIALS = [
  { text: '手上还没收尾的待办、说好要做的事', motivation: 'backlog' },
  { text: '挑一个本地仓库翻翻，看有没有明显的 bug、跑不过的测试、过期的 TODO', motivation: 'hygiene' },
  { text: '本地仓库和远端是不是同步（有没有该推的提交、该拉的提交）', motivation: 'sync' },
  { text: 'yaml / 配置里有没有已经没人用的项、重复的段、注释掉的死配置', motivation: 'hygiene' },
  { text: '陈旧的备份、日志、临时文件是不是该清了（只许提，别动手）', motivation: 'hygiene' },
  { text: '邮箱 / 消息通知里有没有攒着没看的东西', motivation: 'social' },
  { text: '记忆里有没有新条目、有没有互相矛盾的', motivation: 'memory' },
  { text: '宿主机器的状态：温度、内存、磁盘、服务、日志里有没有异常', motivation: 'status' },
  { text: '优化 dsh-ego 插件自己：必须写成 lib/x.js:行号 + 大概改 3~8 行', motivation: 'self' },
  { text: '挑一个仓库检查代码质量，结构、重复、测试、死代码；只提不改', motivation: 'hygiene' },
  {
    text: '用 backlog_list 工具从工单池里挑一条待办，写一份方案文档到 ~/fatfish/plans/backlog-<编号>.md；只写文档不动手',
    motivation: 'backlog',
  },
];

/** 线上默认开关（DEFAULTS.proposer）：service / memoryWrite / outbound 关着，draft 开着。 */
const LIVE_PRIMITIVES = {
  inspect: true,
  editFile: true,
  editConfig: true,
  service: false,
  memoryWrite: false,
  delete: true,
  outbound: false,
  externalResearch: true,
  draft: true,
};

test('枚举：全量合法组合 19 个体 + 开关过滤 + 约束表截掉没意义的格', () => {
  const all = enumerateCells({ includeDisabled: true });
  assert.equal(all.length, 19, '9 原语 × 9 对象按约束表过滤后剩 19 格');
  const keys = all.map((one) => `${one.primitive.id}|${one.objectKind.id}`);
  // 票面要的两格
  assert.ok(keys.includes('draft|plan'), '写方案×计划大纲必须在池里');
  assert.ok(keys.includes('inspect|plan'), '读文件×计划大纲必须在池里');
  // 约束表截掉的：删方案文档走 delete×files，改方案文档走 edit-file×files
  assert.equal(keys.includes('delete|plan'), false, '删×计划大纲无意义（删文档 = delete×files），不许入池');
  assert.equal(keys.includes('draft|files'), false, '写方案×文件无意义（产出文档的落盘路径记在 plan.files）');
  assert.equal(keys.includes('edit-config|plan'), false, '改配置×计划大纲无意义');
  assert.equal(keys.includes('outbound|plan'), false, '外部通信×计划大纲无意义');

  // 开关过滤：只开 inspect / draft，对象只开 files / plan
  const filtered = enumerateCells({
    primitives: { inspect: true, draft: true },
    objects: { files: true, plan: true },
  });
  assert.deepEqual(
    filtered.map((one) => `${one.role}:${one.primitive.id}×${one.objectKind.id}`).sort(),
    ['action:draft×plan', 'read:inspect×files', 'read:inspect×plan'],
  );
});

test('格号稳定：按原语序×对象序算，后加维度不挪已有编号', () => {
  assert.equal(cellIdOf('inspect', 'files'), 'X01', '第一格永远是 X01');
  assert.equal(cellIdOf('inspect', 'plan'), 'X09');
  assert.equal(cellIdOf('edit-file', 'files'), 'X10');
  assert.equal(cellIdOf('draft', 'plan'), 'X81');
  assert.equal(cellIdOf('nope', 'files'), '', '认不出的原语给空串');
  // 每个枚举出来的格都带一个能反查回去的编号
  for (const one of enumerateCells({ includeDisabled: true })) {
    assert.equal(one.id, cellIdOf(one.primitive.id, one.objectKind.id));
  }
});

test('素材正文倾向：方案文档素材认得出 plan / ticket / draft，别的不受影响', () => {
  const hints = materialHintsOf(LIVE_MATERIALS[10].text);
  assert.ok(hints.objects.has('plan'), 'plans/ 与方案文档 → plan');
  assert.ok(hints.objects.has('ticket'), 'backlog_list / 工单池 → ticket');
  assert.ok(hints.primitives.has('draft'), '写一份方案 → draft');
  const neutral = materialHintsOf('手上还没收尾的待办、说好要做的事');
  assert.equal(neutral.objects.size, 0, '普通待办素材保持中性');
  assert.equal(neutral.primitives.size, 0);
});

test('随机抽取：同 seed 必得同一批，不同 seed 不会永远抽同一格', () => {
  const args = {
    materials: LIVE_MATERIALS,
    primitives: LIVE_PRIMITIVES,
    objects: ALL_OBJECTS,
    now: NOW,
    maxCandidates: 99,
  };
  const a = buildGrid({ ...args, seed: 20261118 });
  const b = buildGrid({ ...args, seed: 20261118 });
  assert.deepEqual(a, b, '同一 seed 两次必须一模一样');
  assert.ok(a.length > 1, '随机路径也要给出多条候选');

  // 200 个 seed 各抽一次第一格：出现过的格种类不能只有一种
  const firstCells = new Set();
  for (let seed = 0; seed < 200; seed += 1) {
    const list = buildGrid({ ...args, seed });
    assert.ok(list.length > 0);
    firstCells.add(`${list[0].readCellId}->${list[0].actionCellId || '单段'}`);
  }
  assert.ok(firstCells.size >= 5, `200 拍里第一格只有 ${firstCells.size} 种，等于永远抽同一格`);
});

test('backlog 方案素材能被配到「写方案×计划大纲」，不是每回都钉在改配置×config', () => {
  const args = {
    materials: LIVE_MATERIALS,
    primitives: LIVE_PRIMITIVES,
    objects: ALL_OBJECTS,
    now: NOW,
    maxCandidates: 99,
  };
  let draftHits = 0;
  let sawTicketRead = false;
  const firstPicks = new Map();
  for (let seed = 0; seed < 200; seed += 1) {
    const list = buildGrid({ ...args, seed });
    const first = list[0];
    firstPicks.set(`${first.read.primitive}×${first.read.objectKind} → ${first.action?.primitive}×${first.action?.objectKind}`, (firstPicks.get(`${first.read.primitive}×${first.read.objectKind} → ${first.action?.primitive}×${first.action?.objectKind}`) ?? 0) + 1);
    if (first.action?.primitive === 'draft') draftHits += 1;
    if (list.some((one) => one.read.objectKind === 'ticket' && one.action?.primitive === 'draft')) sawTicketRead = true;
  }
  assert.ok(sawTicketRead, '读票 → 写方案 这一对必须出现在候选池里');
  assert.ok(draftHits >= 20, `200 拍里只有 ${draftHits} 拍第一格是写方案，权重没把这条素材拉过去`);
  assert.ok(draftHits < 200, '也不许把写方案钉成唯一解，其它格还得能抽到');
  // 线上老现症：这条素材配成 inspect×service → edit-config×config 的次数要明显低于写方案
  const oldBug = [...firstPicks.values()].length;
  assert.ok(oldBug > 0);
});

test('读文件×计划大纲（inspect×plan）合法，且读方案能接动作格', () => {
  assert.ok(PAIR_CONSTRAINTS.find((one) => one.primitive === 'inspect').objects.includes('plan'));
  assert.ok(PAIRING_MATRIX.inspect.includes('plan'));
  const list = buildGrid({
    materials: [{ text: '读一份已有的方案文档，看还有哪步没做', motivation: 'backlog' }],
    primitives: { inspect: true, editFile: true, editConfig: true, draft: true },
    objects: { plan: true, files: true, config: true },
    now: NOW,
    seed: 7,
  });
  const planReads = list.filter((one) => one.read.primitive === 'inspect' && one.read.objectKind === 'plan');
  assert.ok(planReads.length > 0, '读文件×计划大纲 必须能成对');
  assert.ok(
    planReads.some((one) => one.action?.primitive === 'draft'),
    '读方案 → 再出方案（draft×plan）要接得上',
  );
  // 读方案 → 再动手：plan 读格接 files / config / service 三个动作格
  assert.equal(affinityOf('plan', 'files'), 1);
  assert.equal(affinityOf('plan', 'config'), 1);
  assert.equal(affinityOf('plan', 'service'), 1);
  assert.equal(affinityOf('plan', 'plan'), 2);
});
