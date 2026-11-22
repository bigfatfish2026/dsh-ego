/**
 * 可观测性：每条 gate 判定 / 每次裁决 / 每版 stage2 都留一句话原因。
 *
 * 盯四件事：
 *   1. gate 明细行统一 `ga_hit:<GA>｜<reject|downgrade|unsupported>｜why:<原因>`，
 *      GA5 / GA6 两条用真 verdict 跑出来，断言整行字符串；GA17 这类未核条目
 *      现在收进 unsure 交 arbiter 判，不再直接摊明细；
 *   2. `judge_verdict:<action>｜why:<reason 前 120 字>`；
 *   3. `stage2_stats｜…` 字段顺序与写法固定；
 *   4. stage2 提示词里「按候选行的读建议直接读，目录扫描最多 1 次」那句在源码里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkStage2Plan, createGate, gateHitLines } from '../lib/gate.js';
import { JUDGE_VERDICT_WHY_MAX, judgeVerdictLine } from '../lib/judge.js';
import { buildStage2Prompt, formatStage2Stats, rewriteFieldLines } from '../lib/proposer.js';
import { toolStats } from '../lib/agent-run.js';

/* ── 夹具：跟 gate-stage2 的候选/方案同形状，只留本文件要用的字段 ── */

const cell = (primitive, objectKind) => ({
  primitive,
  primitiveKey: primitive,
  objectKind,
  objectKey: objectKind,
});

const candidate = (over = {}) => ({
  id: 'C01',
  read: cell('inspect', 'files'),
  action: cell('edit-file', 'files'),
  material: '翻仓库找跑不过的测试',
  motivation: 'hygiene',
  defaults: { impact: 'local-write', reversibility: 'auto' },
  ...over,
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

const context = { candidates: [candidate()] };

/* ── 1. gate 明细行 ───────────────────────────────────────────────── */

test('gate 明细行：GA5 拒 / GA6 降级统一 ga_hit:<GA>｜<处置>｜why:<原因>；GA17 未核交给 arbiter 不摊明细', async () => {
  // GA6 降级：候选默认影响面 local-write，方案的 intent.impact.paths 却是空的
  const ga6 = checkStage2Plan(
    plan({
      intent: {
        impact: { paths: [], services: [], remotes: [] },
        reversibility: 'auto',
        undo: { kind: '', ref: '', howto: 'git checkout -- lib/gate.js' },
      },
    }),
    context,
  );
  const ga6Line = gateHitLines(ga6).find((line) => line.startsWith('ga_hit:GA6｜downgrade｜'));
  assert.equal(
    ga6Line,
    'ga_hit:GA6｜downgrade｜why:intent.impact.paths 是空的：候选 C01 的默认影响面是 local-write，要填路径',
  );

  /*
   * GA17 未核：素材只有方向描述、没有可认的文件锚点。这类灰色条目现在收进 unsure
   * 交给 arbiter 判，不再直接摊成 ga_hit:…｜unsupported｜…（判完 / 失败降级时才由
   * 合并结果写回 unsupported）。
   */
  const ga17 = checkStage2Plan(plan(), context);
  assert.ok(ga17.unsure.some((one) => one.ga === 'GA17'), 'GA17 的未核条目要进 unsure');
  assert.equal(
    gateHitLines(ga17).some((line) => line.startsWith('ga_hit:GA17｜')),
    false,
    'gate 的明细行只摊 reject / downgrade / unsupported，unsure 不摊',
  );

  // GA5 拒：注入的 checkExists 说路径落在 .git/ 里
  const gate = createGate({ deps: { checkExists: async () => ({ status: 'denied', reason: '路径落在 .git/ 里' }) } });
  const ga5 = await gate.checkPlan(plan(), context);
  const ga5Line = gateHitLines(ga5).find((line) => line.startsWith('ga_hit:GA5｜reject｜'));
  assert.equal(ga5Line, 'ga_hit:GA5｜reject｜why:对象「lib/gate.js」过不了路径检查：路径落在 .git/ 里');

  // 所有明细行一个格式，别一条规则一种写法
  for (const line of [...gateHitLines(ga6), ...gateHitLines(ga5)]) {
    assert.match(line, /^ga_hit:GA\d+｜(reject|downgrade|unsupported)｜why:.+$/);
  }
});

test('gate 明细行排在汇总后面：index.js 先打 ga_hits 再逐条打 ga_hit', () => {
  const index = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/adjudicator.js', import.meta.url), 'utf8')].join('\n');
  const summary = index.indexOf('`ga_hits:');
  const detail = index.indexOf('for (const line of gateHitLines(verdict)) log(line);');
  assert.ok(summary > 0 && detail > summary, '汇总行在前、明细行在后');
  assert.equal(index.includes('ga_hit:'), false, '格式只在 gate.gateHitLine 一处拼，index 不另写一份');
});

/* ── 2. judge_verdict ─────────────────────────────────────────────── */

test('judge_verdict 行：动作 + reason 前 120 字，超长按约定截断并标原文长度', () => {
  assert.equal(
    judgeVerdictLine({ action: 'rewrite', reason: '步骤写得含糊，改成删第 36 行那一段' }),
    'judge_verdict:rewrite｜why:步骤写得含糊，改成删第 36 行那一段',
  );
  const long = '字'.repeat(JUDGE_VERDICT_WHY_MAX + 30);
  assert.equal(
    judgeVerdictLine({ action: 'ask', reason: long }),
    `judge_verdict:ask｜why:${'字'.repeat(JUDGE_VERDICT_WHY_MAX)}…[日志截断，原文 ${JUDGE_VERDICT_WHY_MAX + 30} 字符]`,
  );
  assert.equal(judgeVerdictLine({ action: 'silent' }), 'judge_verdict:silent｜why:（没写理由）');
  const index = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/adjudicator.js', import.meta.url), 'utf8')].join('\n');
  assert.ok(index.includes('log(judgeVerdictLine(judged.decision))'), '每次裁决（含 rewrite 那版）都落一行');
});

/* ── 3. stage2_stats ──────────────────────────────────────────────── */

test('stage2_stats 行：字段顺序与写法固定', () => {
  assert.equal(
    formatStage2Stats({
      ms: 175587,
      turns: 19,
      tools: 9,
      read: 5,
      glob: 2,
      grep: 1,
      bash: 1,
      filesRead: 4,
      emptyGlobs: 1,
      outChars: 1234,
      verdict: 'continue',
      planSteps: 2,
      estLines: 12,
    }),
    'stage2_stats｜ms:175587｜turns:19｜tools:9（read:5 glob:2 grep:1 bash:1）'
      + '｜files_read:4｜empty_globs:1｜out_chars:1234｜verdict:continue｜plan_steps:2｜est_lines:12',
  );
  const index = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/adjudicator.js', import.meta.url), 'utf8')].join('\n');
  assert.ok(index.includes('log(formatStage2Stats({'), 'stage2 每版结束打一行');
});

test('toolStats：从 tool/call、tool/result 事件里数工具数、去重文件数、空 glob', () => {
  const stats = toolStats([
    { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"/a.js"}' } },
    { type: 'tool/call', data: { callId: 'c2', name: 'read', arguments: '{"file_path":"/a.js"}' } },
    { type: 'tool/call', data: { callId: 'c3', name: 'glob', arguments: '{"pattern":"**/*.js"}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{ type: 'tool-result', toolCallId: 'c3', content: [{ type: 'text', text: 'No files found' }] }],
        },
      },
    },
    { type: 'tool/call', data: { callId: 'c4', name: 'grep', arguments: '{}' } },
    { type: 'tool/call', data: { callId: 'c5', name: 'bash', arguments: '{}' } },
    { type: 'tool/call', data: { callId: 'c6', name: 'host_status', arguments: '{}' } },
  ]);
  assert.deepEqual(stats, {
    total: 6,
    read: 2,
    glob: 1,
    grep: 1,
    bash: 1,
    filesRead: 1,
    readPaths: ['/a.js'],
    emptyGlobs: 1,
  });
  assert.deepEqual(toolStats([]), {
    total: 0, read: 0, glob: 0, grep: 0, bash: 0, filesRead: 0, readPaths: [], emptyGlobs: 0,
  });
});

test('toolStats：真实 tool/result 形状（content[0].text）的空 glob 也数得出来', () => {
  // 2026-11-11 的会话事件：文本在 data.message.content[0].text，
  // callId 在 data.message.toolCallId（source.callId 也有）。
  const stats = toolStats([
    { type: 'tool/call', data: { callId: 'call_1', name: 'glob', arguments: '{"pattern":"**/*.js"}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          toolCallId: 'call_1',
          source: { kind: 'tool', callId: 'call_1' },
          content: [{ type: 'text', text: 'No files found matching "**/*.js" under /tmp' }],
        },
      },
    },
    { type: 'tool/call', data: { callId: 'call_2', name: 'glob', arguments: '{"pattern":"lib/**"}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call_2' },
          content: [{ type: 'text', text: 'lib/index.js\nlib/gate.js' }],
        },
      },
    },
  ]);
  assert.equal(stats.glob, 2);
  assert.equal(stats.emptyGlobs, 1, '真实形状的空结果必须数出来，不能恒 0');
});

/* ── 4. 提示词与重写消息 ──────────────────────────────────────────── */

test('stage2 提示词写明：按候选行的读建议直接读，目录扫描最多 1 次', () => {
  const source = fs.readFileSync(new URL('../lib/proposer.js', import.meta.url), 'utf8');
  assert.ok(
    source.includes('候选行末尾的「读建议」就是该踩的实例'),
    '源码里要有这句，不能只写在注释',
  );
  const prompt = buildStage2Prompt([candidate()], []);
  assert.match(prompt, /读建议/);
  assert.match(prompt, /目录扫描最多 1 次/);
});

test('重写消息带上上一版具体字段：原因之外还给出要改的原文', () => {
  const lines = rewriteFieldLines(plan());
  assert.equal(lines[0], '上一版具体字段（哪一处不合格就改哪一处，别动别的）：');
  assert.match(lines[1], /^· object\.kind \/ value \/ anchor：files \/ lib\/gate\.js \/ lib\/gate\.js:36$/);
  assert.match(lines.at(-2), /^· intent\.reversibility \/ impact\.paths \/ impact\.services \/ impact\.remotes：auto \/ lib\/gate\.js/);
  assert.deepEqual(rewriteFieldLines(null), [], '没给 plan 就不硬塞空段');
});
