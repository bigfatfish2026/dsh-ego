/**
 * 空拍也要记账：stage2 pick 留空串时，这一对同样要进 recentCombos。
 *
 * 起因（2026-11-10 21:47 / 21:48 连两拍）：两拍 stage2_pick 都是 C01｜inspect×external-repo，
 * 方案 pick 为空，stage2 自己判「这一格不值得做」，但空拍不回写 recentCombos，
 * 下一拍 grid 排序照旧把它排最前，于是同一格被反复选中、反复留空。
 * 两段式之后单位从一格变成一对（`读|对象→动|对象`），回写的也是那一对。
 *
 * 这里盯三件事：
 *   1. rememberComboIn 的行为：新增、去重挪队尾、上限 10、空 key 不记；
 *   2. 回写之后 grid 真的把那一对剔掉（下一拍换对），不是只在 state 里躺着；
 *   3. index.js 的空拍分支确实调了它并打 stage2_empty_combo 日志；
 *      提示词也把留空理由收窄成「对象本身没新东西」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildGrid, PRIMITIVES } from '../lib/grid.js';
import { buildStage2Prompt } from '../lib/proposer.js';
import { runRewriteLoop } from '../lib/rewrite.js';

const libDir = fileURLToPath(new URL('../lib', import.meta.url));
// 提议段已搬到 lib/engines/proposer.js：源码断言读 index + 提议器两份
const indexSource = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8')].join('\n');

/**
 * 入口 import 要宿主的 @scope 依赖（单测目录没 node_modules），探测方式同
 * entry-import.test.mjs：优先 DSH_EGO_HOST_DEPS，其次顺着 PATH 里的 dsh 反查。
 */
function hostDepsRoot() {
  const roots = [];
  if (process.env.DSH_EGO_HOST_DEPS) roots.push(process.env.DSH_EGO_HOST_DEPS);
  try {
    const dshBin = execSync('command -v dsh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (dshBin) {
      const real = fs.realpathSync(dshBin);
      roots.push(path.join(path.dirname(path.dirname(real)), 'node_modules'));
    }
  } catch {
    // 没有 dsh 就只看环境变量
  }
  return roots.find(
    (root) =>
      fs.existsSync(path.join(root, '@deepseek-ai/schemastery')) &&
      fs.existsSync(path.join(root, '@deepseek-ai/dsh-tools')),
  );
}

/** 把 lib/ 拷进临时目录、链上宿主依赖后 import 入口；只拷一次，后续复用。 */
let entryPromise;
function loadEntry() {
  entryPromise ??= (async () => {
    const depsRoot = hostDepsRoot();
    assert.ok(
      depsRoot,
      '找不到宿主的 @deepseek-ai/schemastery 与 dsh-tools；设 DSH_EGO_HOST_DEPS 指向宿主的 node_modules',
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-empty-'));
    const modules = path.join(tmp, 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    for (const entry of fs.readdirSync(depsRoot)) {
      if (!entry.startsWith('@')) continue;
      fs.symlinkSync(path.join(depsRoot, entry), path.join(modules, entry), 'dir');
    }
    fs.cpSync(libDir, path.join(tmp, 'lib'), { recursive: true });
    try {
      return await import(pathToFileURL(path.join(tmp, 'lib', 'index.js')).href);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
  return entryPromise;
}

test('rememberComboIn：空拍新增该格、同格去重挪队尾、长度不超上限、空 key 不记', async () => {
  const { rememberComboIn, RECENT_COMBOS_LIMIT } = await loadEntry();
  assert.equal(RECENT_COMBOS_LIMIT, 10, '预算是最近 10 拍');

  const PAIR = 'inspect|external-repo→edit-file|external-repo';
  const OTHER = 'inspect|files→edit-file|files';

  // 空拍那一对：从空列表写进去
  let list = rememberComboIn([], PAIR);
  assert.deepEqual(list, [PAIR], '空拍回写要真新增');

  // 同一对重复记：只留一条，并且挪到队尾
  list = rememberComboIn(list, OTHER);
  list = rememberComboIn(list, PAIR);
  assert.deepEqual(list, [OTHER, PAIR], '同一对去重后排到最新');

  // 超出上限从头部丢
  for (let i = 0; i < 25; i += 1) list = rememberComboIn(list, `inspect|files→edit-file|kind-${i}`);
  assert.equal(list.length, RECENT_COMBOS_LIMIT, '长度不许超 10');
  assert.equal(list.at(-1), 'inspect|files→edit-file|kind-24', '最新一条在队尾');
  assert.equal(list.includes(PAIR), false, '最老的被挤出去');

  // 单段读的键（箭尾留空）也走这条回写：能进 recentCombos、重复记只留一条
  assert.deepEqual(rememberComboIn([], 'inspect|session→'), ['inspect|session→'], '单段键能进 recentCombos');
  assert.deepEqual(
    rememberComboIn(['inspect|session→', OTHER], 'inspect|session→'),
    [OTHER, 'inspect|session→'],
    '换到队尾的口径跟对一样',
  );

  // 空 key / 坏 list 不炸
  assert.deepEqual(rememberComboIn([OTHER], ''), [OTHER]);
  assert.deepEqual(rememberComboIn(null, OTHER), [OTHER]);
});

test('空拍回写之后下一拍 grid 剔掉那一格，不再排最前', async () => {
  const { rememberComboIn } = await loadEntry();
  const materials = [{ text: '本地仓库和远端是不是同步', motivation: 'sync' }];
  const primitives = Object.fromEntries(PRIMITIVES.map((p) => [p.key, true]));
  const objects = Object.fromEntries(
    ['files', 'config', 'service', 'memory', 'ticket', 'session', 'externalDoc', 'externalRepo'].map((k) => [k, true]),
  );
  const now = Date.parse('2026-11-10T13:50:00Z');

  const before = buildGrid({ materials, primitives, objects, now, recentCombos: [] });
  const comboOf = (row) => (row.action
    ? `${row.read.primitive}|${row.read.objectKind}→${row.action.primitive}|${row.action.objectKind}`
    : `${row.read.primitive}|${row.read.objectKind}`);
  const first = before[0];
  const picked = comboOf(first);
  assert.match(picked, /→/, '首行应该是两段式的一对');

  // 空拍回写这一对（票面那两拍是 inspect×external-repo，这里用实际首对，逻辑一样）
  const after = buildGrid({
    materials,
    primitives,
    objects,
    now,
    recentCombos: rememberComboIn([], picked),
  });
  const keys = after.map(comboOf);
  assert.equal(keys.includes(picked), false, '回写后这一对被剔掉，下一拍自然换对');
  assert.notEqual(keys[0], picked, '不许再排在最前');
  assert.ok(keys.length > 0, '剔掉一对也还有别的对可提');
});

test('重写循环接线：pick 非空在 gate 之前记账，空拍仍在 gate 放行后记账并落盘', async () => {
  // pick 非空 = stage2 真出了方案：记账提到 gate 校验之前，gate 拒也照样留痕
  const order = [];
  const picked = { pick: 'C01', idea: '翻仓库找 3 个跑不过的测试', why: '上拍留下的', step1: { verdict: 'continue' }, plan: { steps: ['P1×files'], files: ['a.js'], estLines: 0 } };
  const rejected = await runRewriteLoop({
    maxRewrite: 3,
    firstPrompt: 'p1',
    rewritePrompt: () => 'p2',
    stage2: async () => ({ ok: true, plan: picked }),
    checkPlan: async () => {
      order.push('check');
      return { ok: false, reject: [{ ga: 'GA10', why: '锚点对不上' }], downgrade: [], notes: [], unsupported: [], hits: ['GA10'] };
    },
    judge: async () => {
      order.push('judge');
      return { ok: true, decision: { action: 'do' } };
    },
    buildProposal: (plan) => ({ ...plan }),
    onPick: () => order.push('pick'),
    onEmpty: () => order.push('empty'),
    log: () => {},
  });
  assert.deepEqual(order, ['pick', 'check'], 'pick 加分枝必须在 gate 之前，gate 拒之后不再叫终审');
  assert.equal(rejected.kind, 'gateRejected');

  // 空拍那条路保持 1916bf3：等 gate 放行后再记
  order.length = 0;
  const quiet = await runRewriteLoop({
    maxRewrite: 3,
    firstPrompt: 'p1',
    rewritePrompt: () => 'p2',
    stage2: async () => ({ ok: true, plan: { pick: '', idea: '', why: '这一格不值得做' } }),
    checkPlan: async () => {
      order.push('check');
      return { ok: true, allowDo: true, reject: [], downgrade: [], notes: [], unsupported: [], hits: [] };
    },
    judge: async () => {
      order.push('judge');
      return { ok: true, decision: { action: 'do' } };
    },
    buildProposal: (plan) => ({ ...plan }),
    onPick: () => order.push('pick'),
    onEmpty: () => order.push('empty'),
    log: () => {},
  });
  assert.deepEqual(order, ['check', 'empty'], '空拍记账仍等 gate 放行，且不叫终审');
  assert.equal(quiet.kind, 'empty');

  // index 只负责把两份记账和循环接起来：两处 rememberCombo、空拍日志一条不少
  assert.match(indexSource, /onPick: rememberPick/);
  assert.match(indexSource, /onEmpty: rememberEmpty/);
  assert.match(indexSource, /stage2_empty_combo:\$\{comboKey\(candidate\)\}/, '日志要带这一对的 读|对象→动|对象');
  assert.equal(
    (indexSource.match(/rememberCombo\(candidate\);/g) ?? []).length,
    2,
    '只有两处记账：gate 前的 pick 非空、gate 放行后的空拍',
  );
});

test('stage2 提示词：提议器不是主会话，「用户没回话」不是留空理由', () => {
  const prompt = buildStage2Prompt(
    [{
      id: 'C01',
      read: { primitive: 'inspect', objectKind: 'external-repo' },
      action: { primitive: 'edit-file', objectKind: 'external-repo' },
      note: '读 读 × 外部仓库 → 动 改文件 × 外部仓库｜种子：本地仓库和远端是不是同步',
    }],
    [],
    { now: new Date('2026-11-10T13:50:00Z') },
  );
  assert.match(prompt, /你只是提议器，不是主会话/, '身份要写死：提议器不是主会话');
  assert.match(prompt, /不能替用户做决定/, '不能替用户做决定');
  assert.match(prompt, /「用户没回话」「刚打扰过用户」「这一格做过了」都不是留空理由/, '三种借口要点名否掉');
  assert.match(prompt, /对象此刻确实没有可做的新东西/, '留空唯一合法依据是对象本身');
  assert.match(prompt, /正例：why「app\.log 里 0 条新失败/, '要有一个正例');
  assert.match(prompt, /反例：why「用户没回话/, '反例就是票面那种写法');
});
