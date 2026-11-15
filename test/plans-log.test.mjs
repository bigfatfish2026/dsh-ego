/**
 * 方案落盘（lib/plans-log.js）：一份 plan 一行、字段齐、脱敏、append 失败不影响裁决、轮转。
 *
 * 这里只测落盘本身和 rewrite 循环的回调口径，
 * 重放侧的用例在 test/replay.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PLANS_MAX_BYTES,
  PLANS_MAX_LINES,
  appendPlan,
  buildPlanRecord,
  countLines,
  maybeRotate,
} from '../lib/plans-log.js';
import { runRewriteLoop } from '../lib/rewrite.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-plans-'));

const CANDIDATE = {
  id: 'C01',
  read: { primitive: 'inspect', primitiveKey: 'inspect', objectKind: 'files', objectKey: 'files' },
  action: { primitive: 'edit-file', primitiveKey: 'editFile', objectKind: 'files', objectKey: 'files' },
  material: '翻仓库找跑不过的测试',
  motivation: 'hygiene',
};

const PLAN = {
  pick: 'C01',
  step1: { read: 'lib/gate.js:36-70', verdict: 'continue', abortIf: '没有重复分支就 abort' },
  step2: { change: '删掉重复分支', files: ['lib/gate.js'], estLines: 0, undo: 'git checkout -- lib/gate.js' },
  idea: 'lib/gate.js 里有 36 行重复分支',
  why: '上个提交复制粘贴留下的',
  object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:36' },
  evidence: [{ claim: '重复分支在第 36 行', source: 'read', value: '36', at: '2026-11-10T05:28:00Z' }],
  plan: { steps: ['P1×files', 'P2×files'], files: ['lib/gate.js'], estLines: 0 },
  intent: {
    impact: { paths: ['lib/gate.js'], services: [], remotes: [] },
    reversibility: 'auto',
    dryRun: { ok: true, detail: 'read lib/gate.js' },
    undo: { kind: '', ref: '', howto: 'git checkout -- lib/gate.js' },
  },
};

const VERDICT = {
  ok: false,
  allowDo: false,
  hits: ['GA10', 'GA3', 'GA6'],
  reject: [{ ga: 'GA10', why: 'idea 里的数字 55 找不到出处' }],
  downgrade: [{ ga: 'GA6', code: 'GA6', originalAction: 'silent', why: 'reversibility 比候选默认更宽松' }],
  unsupported: [{ ga: 'GA3', why: '没注入 checkExists' }],
  notes: [],
};

const record = (over = {}) => buildPlanRecord({
  ts: 1762776000000,
  callId: 'call-1',
  comboKey: 'inspect|files→edit-file|files',
  candidate: CANDIDATE,
  plan: PLAN,
  verdict: VERDICT,
  veto: { ok: true, hit: null, ran: true },
  judge: { action: 'ask', reason: '值得问一句' },
  outcome: 'decided',
  round: 0,
  ...over,
});

const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

/* ── 一行一份，字段齐 ─────────────────────────────────────────────── */

test('落盘：一份 plan 写一行，字段齐，plan 原文不截断', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'plans.jsonl');
  const res = appendPlan(record(), { file, log: () => {} });
  assert.equal(res.ok, true);
  appendPlan(record({ callId: 'call-2', round: 1 }), { file, log: () => {} });

  const lines = readLines(file);
  assert.equal(lines.length, 2, '两次落盘就是两行，不合并');
  const one = JSON.parse(lines[0]);
  assert.equal(one.ts, 1762776000000);
  assert.equal(one.callId, 'call-1');
  assert.equal(one.comboKey, 'inspect|files→edit-file|files');
  assert.equal(one.round, 0);
  assert.deepEqual(one.candidate, {
    pick: 'C01',
    read: { primitive: 'inspect', primitiveKey: 'inspect', objectKind: 'files', objectKey: 'files' },
    action: { primitive: 'edit-file', primitiveKey: 'editFile', objectKind: 'files', objectKey: 'files' },
    motivation: 'hygiene',
    seed: '翻仓库找跑不过的测试',
  });
  assert.deepEqual(one.plan, PLAN, 'plan 原文整份都在，没截断');
  assert.equal(one.gate.ok, false);
  assert.deepEqual(one.gate.items, [
    { ga: 'GA10', action: 'reject', why: 'idea 里的数字 55 找不到出处' },
    { ga: 'GA6', action: 'downgrade', why: 'reversibility 比候选默认更宽松' },
    { ga: 'GA3', action: 'unsupported', why: '没注入 checkExists' },
  ]);
  assert.deepEqual(one.gate.hits, ['GA10', 'GA3', 'GA6']);
  assert.deepEqual(one.veto, { ok: true, hit: null, ran: true });
  assert.deepEqual(one.judge, { action: 'ask', reason: '值得问一句' });
  assert.equal(one.outcome, 'decided');
  assert.equal(JSON.parse(lines[1]).round, 1);
});

test('落盘：judge / veto 没跑就写 null，不编假裁决', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'plans.jsonl');
  appendPlan(record({ judge: null, veto: null, outcome: 'gate_rejected' }), { file, log: () => {} });
  const one = JSON.parse(readLines(file)[0]);
  assert.equal(one.judge, null);
  assert.equal(one.veto, null);
  assert.equal(one.outcome, 'gate_rejected');
});

/* ── 脱敏 ────────────────────────────────────────────────────────── */

test('落盘：写前过 mask，sk- / ghp_ / github_pat_ / crsr_ / oc_ 都不落明文', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'plans.jsonl');
  const secrets = [
    'sk-live_abcdefgh12345678',
    'ghp_abcdefgh12345678',
    'github_pat_abcdefghij1234567890',
    'gho_abcdefgh12345678',
    'ghu_abcdefgh12345678',
    'ghs_abcdefgh12345678',
    'ghr_abcdefgh12345678',
    'crsr_abcdefgh-1234',
    'oc_abcdefgh-1234',
  ];
  const plan = {
    ...PLAN,
    idea: `拿 ${secrets[0]} 试一下`,
    why: secrets.join(' / '),
    evidence: [{ claim: `token ${secrets[2]}`, source: 'read', value: secrets[3], at: '' }],
  };
  appendPlan(record({ plan, judge: { action: 'ask', reason: `理由里带 ${secrets[8]}` } }), { file, log: () => {} });
  const text = fs.readFileSync(file, 'utf8');
  for (const secret of secrets) assert.equal(text.includes(secret), false, `${secret} 不许明文落盘`);
  assert.match(text, /\*\*\*/);
  const one = JSON.parse(readLines(file)[0]);
  assert.deepEqual(Object.keys(one.plan), Object.keys(PLAN), '脱敏后仍是合法 JSON，键不变');
  assert.match(one.plan.idea, /\*\*\*/);
});

/* ── 写失败不影响裁决 ─────────────────────────────────────────────── */

test('落盘：append 抛错只记一行日志，不往外抛', () => {
  const logs = [];
  const res = appendPlan(record(), {
    file: '/no/such/dir/plans.jsonl',
    appendFile: () => {
      const error = new Error('ENOSPC: no space left on device');
      error.code = 'ENOSPC';
      throw error;
    },
    log: (line) => logs.push(line),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /ENOSPC/);
  assert.equal(logs.some((line) => /^plans_log_fail:/.test(line)), true);
  assert.equal(logs.some((line) => /ENOSPC/.test(line)), true);
});

test('落盘：注入假 fs 写失败，rewrite 循环照旧裁决（state/流程都不受影响）', async () => {
  const logs = [];
  const wrote = [];
  const planA = { ...PLAN, idea: '第一版：36 行重复分支' };
  const planB = { ...PLAN, idea: '第二版：36 行重复分支' };
  let call = 0;
  const outcome = await runRewriteLoop({
    maxRewrite: 3,
    firstPrompt: 'p1',
    rewritePrompt: () => 'p2',
    stage2: async () => {
      call += 1;
      return { ok: true, plan: call === 1 ? planA : planB };
    },
    checkPlan: async (plan) => (plan === planA
      ? { ok: true, hits: ['GA10'], reject: [], downgrade: [{ ga: 'GA10', code: 'GA10', originalAction: 'silent', why: '数字没出处' }], unsupported: [] }
      : { ok: true, hits: [], reject: [], downgrade: [], unsupported: [] }),
    checkVeto: async () => ({ ok: true, reason: '', hit: null }),
    judge: async () => ({ ok: true, decision: { action: 'ask', text: '要不要开票', reason: '还行' } }),
    buildProposal: (plan) => plan,
    onPlanRecord: (entry) => {
      wrote.push(entry);
      // 假 fs：append 全炸。落盘不允许影响裁决，所以这里不该把循环带崩
      appendPlan(record({ plan: entry.plan }), {
        file: '/no/such/dir/plans.jsonl',
        appendFile: () => {
          throw new Error('EACCES: permission denied');
        },
        log: (line) => logs.push(line),
      });
    },
    log: (line) => logs.push(line),
  });
  assert.equal(outcome.kind, 'decided');
  assert.equal(outcome.rewrites, 1);
  assert.equal(wrote.length, 2, '两版 plan 各回调一次');
  assert.equal(wrote[0].round, 0);
  assert.equal(wrote[0].outcome, 'rewrite');
  assert.deepEqual(wrote[0].verdict.downgrade.map((one) => one.ga), ['GA10']);
  assert.equal(wrote[1].round, 1);
  assert.equal(wrote[1].outcome, 'decided');
  assert.deepEqual(wrote[1].judge, { action: 'ask', reason: '还行' });
  assert.equal(logs.filter((line) => /^plans_log_fail:/.test(line)).length, 2);
});

test('落盘：onPlanRecord 自己抛错也只记一行日志，不中断重写循环', async () => {
  const logs = [];
  const outcome = await runRewriteLoop({
    maxRewrite: 3,
    firstPrompt: 'p1',
    rewritePrompt: () => 'p2',
    stage2: async () => ({ ok: true, plan: PLAN }),
    checkPlan: async () => ({ ok: true, hits: ['GA10'], reject: [], downgrade: [{ ga: 'GA10', code: 'GA10', originalAction: 'silent', why: 'x' }], unsupported: [] }),
    checkVeto: async () => ({ ok: true }),
    judge: async () => ({ ok: false, error: '不该走到这' }),
    buildProposal: (plan) => plan,
    onPlanRecord: () => {
      throw new Error('boom');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(outcome.kind, 'exhausted', '重写次数用满照旧收口');
  // 首轮 + 3 次重写，每版都回调一次；四次都抛，四次都只记一行
  assert.equal(logs.filter((line) => /^plans_log_fail:boom/.test(line)).length, 4);
});

/* ── 轮转 ────────────────────────────────────────────────────────── */

test('轮转：超过行数上限时当前文件改名 .1，新文件从空开始', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'plans.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`, 'utf8');

  const res = maybeRotate({ file, maxLines: 1, log: () => {} });
  assert.equal(res.rotated, true);
  assert.equal(fs.existsSync(file), false, '旧文件已经让位，新文件还没建 = 空');
  assert.equal(countLines(fs.readFileSync(`${file}.1`)), 2, '旧的 .1 被同内容覆盖');

  // 轮转后再落一行：新文件只有这一行
  const appended = appendPlan(record(), { file, maxLines: 1, log: () => {} });
  assert.equal(appended.ok, true);
  assert.equal(readLines(file).length, 1);
  assert.equal(readLines(`${file}.1`).length, 2);
});

test('轮转：超过字节上限也轮转；没超就不动', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'plans.jsonl');
  fs.writeFileSync(file, 'x'.repeat(100), 'utf8');
  assert.equal(maybeRotate({ file, maxBytes: 10, maxLines: 9999, log: () => {} }).rotated, true);
  assert.equal(fs.existsSync(`${file}.1`), true);

  const second = path.join(dir, 'keep.jsonl');
  fs.writeFileSync(second, 'x'.repeat(100), 'utf8');
  assert.equal(maybeRotate({ file: second, maxBytes: PLANS_MAX_BYTES, maxLines: PLANS_MAX_LINES, log: () => {} }).rotated, false);
  assert.equal(fs.existsSync(`${second}.1`), false);
});

test('轮转：轮转失败（rename 抛错）只记日志，append 照旧', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'plans.jsonl');
  fs.writeFileSync(file, 'old\n', 'utf8');
  const logs = [];
  const res = appendPlan(record(), {
    file,
    maxLines: 0,
    rename: () => {
      throw new Error('EPERM: operation not permitted');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(res.ok, true);
  assert.equal(logs.some((line) => /^plans_log_rotate_fail:EPERM/.test(line)), true);
  assert.equal(readLines(file).length, 2);
});

test('countLines：末尾有换行 / 没换行都数对', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
});
