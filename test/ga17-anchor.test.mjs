/**
 * GA17：代码只报「素材有没有文件锚点、方案第一步落在哪」，对不对交给 arbiter。
 *
 * 以前这里猜过两轮（eae50de）：先把「单字母 + 扩展名」当占位符剔掉，再把路径按分量
 * 尾部对齐硬判同一个文件。两次都是拿正则替模型判断「像不像例子 / 是不是一处」，
 * 于是出现假锚点把合规方案判降级。现在代码只抽字面路径，判断整条交给 arbiter。
 *
 * 盯四件事：
 *   1. 带扩展名的路径一律按字面抽出来，不猜占位符；
 *   2. 默认 9 条素材都是纯方向描述，抽不出锚点 → 报「没有锚点」；
 *   3. 有锚点时把锚点和第一步落点都写进 subject，不再自己判对不上；
 *   4. 父目录不同 / 绝对相对写法不同这两种历史反例，也都只交事实、不硬判。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkStage2Plan, materialFilePaths } from '../lib/gate.js';

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const cell = (primitive, objectKind) => ({
  primitive,
  primitiveKey: primitive,
  objectKind,
  objectKey: objectKind,
});

const candidate = (material) => ({
  id: 'C01',
  read: cell('inspect', 'files'),
  action: cell('edit-file', 'files'),
  material,
  motivation: 'self',
  note: '读 读 × 文件 → 动 改文件 × 文件｜有副作用 auto',
  defaults: { impact: 'local-write', reversibility: 'auto' },
});

const plan = (over = {}) => ({
  pick: 'C01',
  step1: { read: 'lib/gate.js:801', verdict: 'continue', abortIf: '那一行已经不是死代码就 abort' },
  step2: { change: '删掉 lib/gate.js 里那行死分支', files: ['lib/gate.js'], estLines: 3, undo: 'git checkout -- lib/gate.js' },
  idea: 'lib/gate.js 第 801 行有一条死分支，可以删掉',
  why: '没有别的调用方，测试能覆盖',
  object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:801' },
  evidence: [{ claim: '死分支在第 801 行', source: 'read', value: '801', at: '2026-11-11T10:00:00Z' }],
  plan: { steps: ['P1×files', 'P2×files'], files: ['lib/gate.js'], estLines: 3 },
  intent: {
    impact: { paths: ['lib/gate.js'], services: [], remotes: [] },
    reversibility: 'auto',
    dryRun: { ok: true, detail: 'read lib/gate.js:801' },
    undo: { kind: 'git-checkout', ref: 'lib/gate.js', howto: 'git checkout -- lib/gate.js' },
  },
  ...over,
});

const ga17 = (verdict) => verdict.unsure.find((one) => one.ga === 'GA17');

/* ── 一、只抽字面路径，不猜占位符 ────────────────────────────────── */

test('GA17：带扩展名的路径按字面抽，x.js / x.test.mjs 也不替模型排除', () => {
  assert.deepEqual(
    materialFilePaths('必须写成 lib/x.js:行号，再跑 test/x.test.mjs').sort(),
    ['lib/x.js', 'test/x.test.mjs'],
  );
  assert.deepEqual(materialFilePaths('改成 a.ts 那种写法'), ['a.ts']);
  assert.deepEqual(materialFilePaths('改 lib/gate.js:801'), ['lib/gate.js']);
});

test('GA17：默认 10 条素材都是方向描述，一条锚点都抽不出来', () => {
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const texts = [...patch.matchAll(/^\s*- text:\s*(.+)$/gm)].map((one) => one[1].trim());
  // 9 条通用方向 + 1 条 solution（取已定方案并落地）；solution 那条也不许写死文件锚点
  assert.equal(texts.length, 10, '默认素材池是 10 条');
  for (const text of texts) {
    assert.deepEqual(materialFilePaths(text), [], `这条素材不该抓出锚点：${text}`);
  }
});

/* ── 二、有锚点也只交事实 ────────────────────────────────────────── */

test('GA17：素材只剩占位符时按「有锚点」报事实，不再拿假文件判降级', () => {
  const fakeOnly = candidate('优化 dsh-ego 插件自己：必须写成 lib/x.js:行号 + 跑 test/x.test.mjs');
  const verdict = checkStage2Plan(plan(), { candidates: [fakeOnly] });
  const note = ga17(verdict);
  assert.ok(note);
  assert.match(note.why, /有文件锚点 lib\/x\.js、test\/x\.test\.mjs/);
  assert.match(note.subject, /step1\.read=lib\/gate\.js:801/);
  assert.equal(verdict.downgrade.some((one) => one.ga === 'GA17'), false, '像不像例子是 arbiter 的判断');
});

test('GA17：素材和第一步都指向 lib/gate.js 时，仍把两处事实交 arbiter', () => {
  const withFile = candidate('优化 dsh-ego 插件自己：lib/gate.js 第 801 行的死分支可以删');
  const verdict = checkStage2Plan(plan(), { candidates: [withFile] });
  const note = ga17(verdict);
  assert.ok(note);
  assert.match(note.why, /lib\/gate\.js/);
  assert.match(note.subject, /step1\.read=lib\/gate\.js:801/);
  assert.equal(verdict.downgrade.some((one) => one.ga === 'GA17'), false);
});

/* ── 三、历史反例：父目录不同 / 绝对相对写法 ────────────────────── */

test('GA17：素材 /opt/other/gate.js、方案 lib/gate.js——两条路径都列出来，不下结论', () => {
  const other = candidate('/opt/other/gate.js 那份实现有问题');
  const verdict = checkStage2Plan(plan(), { candidates: [other] });
  const note = ga17(verdict);
  assert.ok(note);
  assert.match(note.why, /opt\/other\/gate\.js/);
  assert.match(note.subject, /object\.value=lib\/gate\.js/);
  assert.equal(verdict.downgrade.some((one) => one.ga === 'GA17'), false, '父目录不同不再是代码判的死罪');
});

test('GA17：素材绝对、方案相对，原文都写进 subject 让 arbiter 对', () => {
  const abs = candidate('/srv/app/plugins/dsh-ego/lib/gate.js 的十七关注释');
  const verdict = checkStage2Plan(plan(), { candidates: [abs] });
  const note = ga17(verdict);
  assert.ok(note);
  assert.match(note.subject, /srv\/app\/plugins\/dsh-ego\/lib\/gate\.js/);
  assert.match(note.subject, /step1\.read=lib\/gate\.js:801/);
  assert.equal(verdict.downgrade.some((one) => one.ga === 'GA17'), false);
});
