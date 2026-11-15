/**
 * 想法重放（lib/replay.js + scripts/replay.js）：改 gate 前拿落盘的旧 plan 原地重跑。
 *
 * 三个方向各一条：旧拒新过 = better、旧过新拒 = worse、
 * 前后一致 = same；再加 replayFile 的四个过滤和 CLI 冒烟。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { replayFile, replayPlan } from '../lib/replay.js';
import { defaultProviderFromDump, formatReport, main, parseArgs } from '../scripts/replay.js';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
const CLI = path.join(PLUGIN_DIR, 'scripts', 'replay.js');

const CANDIDATE = {
  pick: 'C01',
  read: { primitive: 'inspect', primitiveKey: 'inspect', objectKind: 'files', objectKey: 'files' },
  action: { primitive: 'edit-file', primitiveKey: 'editFile', objectKind: 'files', objectKey: 'files' },
  motivation: 'hygiene',
  seed: '翻仓库找跑不过的测试',
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

const record = (over = {}) => ({
  ts: 1762776000000,
  callId: 'call-1',
  comboKey: 'inspect|files→edit-file|files',
  candidate: CANDIDATE,
  plan: PLAN,
  gate: { ok: true, allowDo: true, hits: [], items: [] },
  veto: { ok: true, hit: null, ran: true },
  judge: { action: 'ask', reason: '值得问一句' },
  outcome: 'decided',
  round: 0,
  ...over,
});

/* ── 三个方向 ─────────────────────────────────────────────────────── */

test('重放：旧 gate 拒、现 gate 放过 → better，before/after 的 GA 编号对得上', async () => {
  const old = record({
    gate: {
      ok: false,
      allowDo: false,
      hits: ['GA10'],
      items: [{ ga: 'GA10', action: 'reject', why: 'idea 里的数字 55 找不到出处' }],
    },
  });
  const out = await replayPlan(old, { nowMs: Date.parse('2026-11-11T21:00:00+08:00') });
  assert.equal(out.changed, 'better');
  assert.deepEqual(out.before.map((one) => [one.ga, one.action]), [['GA10', 'reject']]);
  assert.equal(out.after.some((one) => one.ga === 'GA10' && one.action !== 'unsupported'), false);
  assert.equal(out.pass.before, false);
  assert.equal(out.pass.after, true);
  assert.equal(out.notes.some((line) => /^GA10 不再命中（旧：idea 里的数字 55 找不到出处）$/.test(line)), true);
});

test('重放：旧 gate 放过、现 gate 拦下 → worse', async () => {
  const plan = {
    ...PLAN,
    // 6 步超过 5 步上限，GA12 是纯计数判死，不依赖 arbiter
    plan: { steps: ['P1×files', 'P2×files', 'P2×files', 'P2×files', 'P2×files', 'P2×files'], files: ['lib/gate.js'], estLines: 0 },
  };
  const out = await replayPlan(record({ plan }), { nowMs: Date.parse('2026-11-11T21:00:00+08:00') });
  assert.equal(out.changed, 'worse');
  assert.deepEqual(out.after.filter((one) => one.action === 'downgrade').map((one) => one.ga), ['GA12']);
  assert.equal(out.before.length, 0);
  assert.equal(out.notes.some((line) => /^新命中 GA12：/.test(line)), true);
});

test('重放：gate 规则没变、plan 也没变 → same', async () => {
  const out = await replayPlan(record(), { nowMs: Date.parse('2026-11-11T21:00:00+08:00') });
  assert.equal(out.changed, 'same');
  assert.deepEqual(out.before, []);
  assert.deepEqual(out.after.filter((one) => one.action !== 'unsupported'), []);
  assert.deepEqual(out.notes, ['ga_hits 没变']);
});

test('重放：vetoEnabled=false 时不看否决台账；记录里 veto 命中就算 worse→better', async () => {
  const vetoed = record({ gate: { ok: true, allowDo: true, hits: [], items: [] }, veto: { ok: false, hit: { rule: 'V1' }, ran: true } });
  const on = await replayPlan(vetoed);
  assert.equal(on.pass.before, false);
  assert.equal(on.pass.after, false);
  assert.equal(on.changed, 'same');

  const off = await replayPlan(vetoed, { vetoEnabled: false });
  assert.equal(off.pass.before, true);
  assert.equal(off.changed, 'same');
});

test('重放：没 plan 原文 / gate 抛错都不崩，只写 notes', async () => {
  const empty = await replayPlan({ ts: 1, gate: { items: [{ ga: 'GA10', action: 'reject', why: 'x' }] } });
  assert.equal(empty.changed, 'same');
  assert.match(empty.notes[0], /没有 plan 原文/);

  const broken = await replayPlan(record(), {
    checkPlan: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(broken.changed, 'same');
  assert.match(broken.notes[0], /重放跑挂了.*boom/);
});

/* ── replayFile 的过滤 ────────────────────────────────────────────── */

const tmpFile = (records) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-replay-'));
  const file = path.join(dir, 'plans.jsonl');
  fs.writeFileSync(file, records.map((one) => JSON.stringify(one)).join('\n') + '\n', 'utf8');
  return file;
};

const oldReject = (ts, ga = 'GA10') => record({
  ts,
  callId: `c-${ts}`,
  gate: { ok: false, allowDo: false, hits: [ga], items: [{ ga, action: 'reject', why: '旧账' }] },
});

test('replayFile：since 只留那一天之后的记录', async () => {
  const file = tmpFile([
    oldReject(Date.parse('2026-11-09T12:00:00+08:00')),
    oldReject(Date.parse('2026-11-11T12:00:00+08:00')),
  ]);
  const out = await replayFile(file, { since: '2026-11-10' });
  assert.equal(out.total, 1);
  assert.equal(out.items[0].ts, Date.parse('2026-11-11T12:00:00+08:00'));
  assert.equal(out.better, 1);
});

test('replayFile：limit 取最近 N 条', async () => {
  const file = tmpFile([
    oldReject(Date.parse('2026-11-09T12:00:00+08:00')),
    oldReject(Date.parse('2026-11-10T12:00:00+08:00')),
    oldReject(Date.parse('2026-11-11T12:00:00+08:00')),
  ]);
  const out = await replayFile(file, { limit: 2 });
  assert.equal(out.scanned, 2);
  assert.deepEqual(out.items.map((one) => one.ts), [
    Date.parse('2026-11-10T12:00:00+08:00'),
    Date.parse('2026-11-11T12:00:00+08:00'),
  ]);
});

test('replayFile：ga 只看历史命中过这条 GA 的记录', async () => {
  const file = tmpFile([
    oldReject(Date.parse('2026-11-09T12:00:00+08:00'), 'GA6'),
    oldReject(Date.parse('2026-11-10T12:00:00+08:00'), 'GA10'),
  ]);
  const out = await replayFile(file, { ga: 'GA10' });
  assert.equal(out.total, 1);
  assert.deepEqual(out.items[0].before.map((one) => one.ga), ['GA10']);
});

test('replayFile：onlyChanged 只留变了的', async () => {
  const file = tmpFile([
    record({ ts: Date.parse('2026-11-09T12:00:00+08:00') }), // 旧账空 → same
    oldReject(Date.parse('2026-11-10T12:00:00+08:00')), // 旧拒新过 → better
  ]);
  const all = await replayFile(file);
  assert.equal(all.total, 2);
  assert.equal(all.better, 1);
  assert.equal(all.same, 1);

  const changed = await replayFile(file, { onlyChanged: true });
  assert.equal(changed.total, 1);
  assert.equal(changed.items[0].changed, 'better');
});

test('replayFile：坏行跳过不炸；读不到文件抛错（CLI 转成 2）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-replay-'));
  const file = path.join(dir, 'plans.jsonl');
  fs.writeFileSync(file, 'not json\n{"ts":0}\n', 'utf8');
  const out = await replayFile(file);
  assert.equal(out.total, 0);
  assert.equal(out.skipped, 2);

  await assert.rejects(() => replayFile(path.join(dir, 'nope.jsonl')), /读不到落盘文件/);
});

/* ── CLI 冒烟 ─────────────────────────────────────────────────────── */

test('CLI：跑夹具，退出码 0，汇总行格式对', () => {
  const file = tmpFile([oldReject(Date.parse('2026-11-11T12:00:00+08:00'))]);
  const res = spawnSync(process.execPath, [CLI, '--file', file, '--limit', '5'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n').filter(Boolean);
  assert.equal(lines[0], '重放 1 条：变好 1｜没变 0｜变差 0');
  assert.match(
    lines[1],
    /^2026-11-11T04:00:00\.000Z inspect\|files→edit-file\|files 变好：GA10 不再命中（旧：旧账）$/,
  );
});

test('CLI：有 worse 时退出码 1；--changed 只列变了的', () => {
  const plan = {
    ...PLAN,
    plan: { steps: ['P1×files', 'P2×files', 'P2×files', 'P2×files', 'P2×files', 'P2×files'], files: ['lib/gate.js'], estLines: 0 },
  };
  const file = tmpFile([
    record({ ts: Date.parse('2026-11-11T12:00:00+08:00'), plan }),
    record({ ts: Date.parse('2026-11-11T13:00:00+08:00') }),
  ]);
  const res = spawnSync(process.execPath, [CLI, '--file', file, '--changed'], { encoding: 'utf8' });
  assert.equal(res.status, 1, res.stderr);
  const lines = res.stdout.split('\n').filter(Boolean);
  assert.equal(lines[0], '重放 1 条：变好 0｜没变 0｜变差 1');
  assert.match(lines[1], / 变差：新命中 GA12：/);
});

/* ── arbiter 第三段───────────────────────────── */

/** 这份 plan 现 gate 会留两条灰色条目：GA10（idea 里的 55 秒没出处）、GA17（素材没有文件锚点） */
const unsurePlan = () => ({
  ...PLAN,
  idea: 'lib/gate.js 里有 36 行重复分支，删掉能省 55 秒',
});

const unsureRecord = (ts = 1762776000000) => record({ ts, callId: `u-${ts}`, plan: unsurePlan() });

/** 假 arbiter 客户端：记下每次提示词，按给定回复回 */
const fakeArbiter = (reply) => {
  const calls = [];
  const client = async (prompt) => {
    calls.push(prompt);
    if (typeof reply === 'function') return reply(prompt, calls.length);
    return reply;
  };
  client.calls = calls;
  return client;
};

const replyOf = (verdicts) => ({ ok: true, text: JSON.stringify({ verdicts }) });

test('重放不传 arbiter：unsure 记成 unsupported 留痕，arbiter 显式 null（老行为不退化）', async () => {
  const out = await replayPlan(unsureRecord(), { nowMs: 1762776000000 });
  assert.equal(out.arbiter, null);
  assert.equal(out.changed, 'same');
  assert.equal(out.pass.before, true);
  assert.equal(out.pass.after, true);
  const ga10 = out.after.filter((one) => one.ga === 'GA10');
  assert.deepEqual(ga10.map((one) => one.action), ['unsupported']);
  assert.match(ga10[0].why, /55/);
});

test('重放接 arbiter：判 pass 维持原判定，changed 不变，明细里留一条放行', async () => {
  const client = fakeArbiter(replyOf([
    { ga: 'GA10', decision: 'pass', why: '55 秒是计数' },
    { ga: 'GA17', decision: 'pass', why: '素材是方向描述' },
  ]));
  const out = await replayPlan(unsureRecord(), { nowMs: 1762776000000, arbiter: client });
  assert.equal(client.calls.length, 1);
  assert.equal(out.changed, 'same');
  assert.equal(out.arbiter.failed, null);
  assert.equal(out.arbiter.cases, 2);
  assert.equal(out.arbiter.sent, 2);
  assert.deepEqual(out.arbiter.verdicts.map((one) => one.decision), ['pass', 'pass']);
  assert.equal(out.after.some((one) => one.ga === 'GA10' && one.action === 'unsupported'), true);
  assert.equal(out.pass.after, true);
});

test('重放接 arbiter：判 reject / downgrade 都算变差，items 带 arbiter 明细', async () => {
  const client = fakeArbiter(replyOf([
    { ga: 'GA10', decision: 'reject', why: '55 秒是编的' },
    { ga: 'GA17', decision: 'downgrade', why: '素材对不上' },
  ]));
  const out = await replayPlan(unsureRecord(), { nowMs: 1762776000000, arbiter: client });
  assert.equal(out.changed, 'worse');
  assert.equal(out.pass.after, false);
  assert.equal(out.pass.before, true);
  assert.deepEqual(
    out.after.filter((one) => one.action !== 'unsupported').map((one) => [one.ga, one.action]),
    [['GA10', 'reject'], ['GA17', 'downgrade']],
  );
  assert.deepEqual(out.arbiter.verdicts.map((one) => one.ga), ['GA10', 'GA17']);
  assert.equal(out.arbiter.failed, null);
});

test('重放接 arbiter：客户端抛错不崩，failed 非空、verdicts 空、照 old 行为放行', async () => {
  const client = fakeArbiter(() => {
    throw new Error('超时');
  });
  const out = await replayPlan(unsureRecord(), { nowMs: 1762776000000, arbiter: client });
  assert.equal(out.changed, 'same');
  assert.equal(typeof out.arbiter.failed, 'string');
  assert.ok(out.arbiter.failed.length > 0);
  assert.deepEqual(out.arbiter.verdicts, []);
  assert.equal(out.pass.after, true);
  assert.equal(out.after.some((one) => one.ga === 'GA10' && one.action === 'unsupported'), true);
});

test('重放接 arbiter：坏 JSON 也按失败记，不影响下一条', async () => {
  const client = fakeArbiter((prompt, n) => (n === 1
    ? { ok: true, text: '这不是 JSON' }
    : replyOf([{ ga: 'GA10', decision: 'pass', why: '计数' }])));
  const file = tmpFile([unsureRecord(), unsureRecord(1762776060000)]);
  const out = await replayFile(file, { arbiter: client, nowMs: 1762776000000 });
  assert.equal(out.total, 2);
  assert.equal(client.calls.length, 2);
  assert.equal(out.items[0].arbiter.failed, '坏 JSON');
  assert.deepEqual(out.items[0].arbiter.verdicts, []);
  assert.equal(out.items[1].arbiter.failed, null);
  assert.deepEqual(out.items[1].arbiter.verdicts.map((one) => one.decision), ['pass']);
  // GA17 模型判 pass 之外的没判到：按 unsupported 兜底
  assert.equal(out.items[1].arbiter.sent, 2);
});

test('replayFile：传了 arbiter 才给汇总，没传就是 null', async () => {
  const file = tmpFile([unsureRecord()]);
  const plain = await replayFile(file, { nowMs: 1762776000000 });
  assert.equal(plain.arbiter, null);
  const client = fakeArbiter(replyOf([{ ga: 'GA10', decision: 'reject', why: '编的' }]));
  const withArbiter = await replayFile(file, { arbiter: client, nowMs: 1762776000000 });
  assert.deepEqual(withArbiter.arbiter, { cases: 2, sent: 2, skipped: 0, pass: 0, reject: 1, downgrade: 0, failed: 0 });
});

test('replayPlan：arbiter 只在 gate 没拒之后才跑（前面收工不白花钱）', async () => {
  const client = fakeArbiter(replyOf([{ ga: 'GA10', decision: 'reject', why: '编的' }]));
  const rejected = await replayPlan(unsureRecord(), {
    arbiter: client,
    checkPlan: async () => ({
      ok: false,
      allowDo: false,
      reject: [{ ga: 'GA1', why: 'pick 不在候选表里' }],
      downgrade: [],
      unsupported: [],
      unsure: [{ ga: 'GA10', why: 'idea 里的数字 55 找不到出处' }],
      notes: [],
      hits: ['GA1'],
    }),
  });
  assert.equal(rejected.changed, 'worse');
  assert.equal(client.calls.length, 0, 'gate 先拒了，arbiter 不该被叫');
  assert.equal(rejected.arbiter.cases, 0);
  assert.equal(rejected.after.some((one) => one.ga === 'GA10' && one.action === 'unsupported'), true);
});

test('replayPlan：maxCases 走 selectArbiterCases 的截断，skipped 记数', async () => {
  const client = fakeArbiter(replyOf([{ ga: 'GA10', decision: 'pass', why: '计数' }]));
  const out = await replayPlan(unsureRecord(), {
    nowMs: 1762776000000,
    arbiter: client,
    arbiterConfig: { maxCases: 1 },
  });
  assert.equal(out.arbiter.cases, 2);
  assert.equal(out.arbiter.sent, 1);
  assert.equal(out.arbiter.skipped, 1);
  assert.match(client.calls[0], /GA10/);
  assert.equal(client.calls[0].includes('GA17'), false, '截掉的 GA17 不许进提示词');
});

/* ── CLI 的 --arbiter ─────────────────────────────────────────────── */

test('CLI parseArgs：--arbiter / --arbiter-model / --max-cases，默认 limit 50', () => {
  const plain = parseArgs([]);
  assert.equal(plain.arbiter, false);
  assert.equal(plain.limit, 50);
  assert.equal(plain.maxCases, 0);

  const on = parseArgs(['--arbiter', '--arbiter-model', 'example-model', '--max-cases', '99']);
  assert.equal(on.arbiter, true);
  assert.equal(on.arbiterModel, 'example-model');
  assert.equal(on.maxCases, 24, '越界按 arbiter 的同一套夹边界');

  assert.throws(() => parseArgs(['--arbiter-model', 'x']), /要跟 --arbiter 一起用/);
  assert.throws(() => parseArgs(['--arbiter', '--max-cases', 'abc']), /--max-cases 要是正整数/);
});

test('CLI：不开 --arbiter 时一次 agent 都不调，输出里也没有 arbiter 行', async () => {
  const client = fakeArbiter(replyOf([{ ga: 'GA10', decision: 'reject', why: '编的' }]));
  const lines = [];
  const code = await main(['--file', tmpFile([unsureRecord()])], {
    arbiter: client,
    write: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.equal(client.calls.length, 0);
  assert.equal(lines.some((line) => line.startsWith('arbiter：')), false);
  assert.equal(lines.length, 2);
});

test('CLI：开 --arbiter 时打汇总行、逐条追 arbiter 判定，reject 让退出码变 1', async () => {
  const client = fakeArbiter(replyOf([
    { ga: 'GA10', decision: 'reject', why: '55 秒是编的' },
    { ga: 'GA17', decision: 'downgrade', why: '素材对不上' },
  ]));
  const lines = [];
  const code = await main(['--file', tmpFile([unsureRecord()]), '--arbiter'], {
    arbiter: client,
    write: (line) => lines.push(line),
  });
  assert.equal(client.calls.length, 1);
  assert.equal(code, 1);
  assert.equal(lines[0], '重放 1 条：变好 0｜没变 0｜变差 1');
  assert.equal(lines[1], 'arbiter：送 2 条｜pass 0｜reject 1｜downgrade 1｜失败 0');
  assert.match(lines[2], /arbiter:GA10｜reject｜why:55 秒是编的/);
  assert.match(lines[2], /arbiter:GA17｜downgrade｜why:素材对不上/);
});

test('CLI：arbiter 全挂了也只记失败、不崩，退出码仍按 worse 算', async () => {
  const client = fakeArbiter(() => {
    throw new Error('没 key');
  });
  const lines = [];
  const code = await main(['--file', tmpFile([unsureRecord()]), '--arbiter'], {
    arbiter: client,
    write: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.equal(lines[1], 'arbiter：送 2 条｜pass 0｜reject 0｜downgrade 0｜失败 1');
});

test('CLI formatReport：没跑 arbiter 的结果不添行，跑了才添', () => {
  const base = { total: 1, better: 0, same: 1, worse: 0, items: [{ changed: 'same', ts: 1762776000000, comboKey: 'k', notes: ['ga_hits 没变'] }] };
  assert.equal(formatReport(base).length, 2);
  const withArbiter = {
    ...base,
    arbiter: { cases: 2, sent: 2, skipped: 0, pass: 1, reject: 1, downgrade: 0, failed: 0 },
    items: [{ ...base.items[0], arbiter: { verdicts: [{ ga: 'ga10', decision: 'REJECT', why: '' }] } }],
  };
  const lines = formatReport(withArbiter);
  assert.equal(lines[0], '重放 1 条：变好 0｜没变 1｜变差 0');
  assert.equal(lines[1], 'arbiter：送 2 条｜pass 1｜reject 1｜downgrade 0｜失败 0');
  assert.match(lines[2], /arbiter:GA10｜reject｜why:（没写原因）$/);
});

test('replayFile：--changed 滤掉「没变」也照样算进 arbiter 汇总', async () => {
  const client = fakeArbiter(replyOf([{ ga: 'GA10', decision: 'pass', why: '计数' }]));
  const file = tmpFile([unsureRecord()]);
  const out = await replayFile(file, { arbiter: client, onlyChanged: true, nowMs: 1762776000000 });
  assert.equal(out.total, 0, '没变的条目被滤掉了');
  assert.equal(out.arbiter.sent, 2, '但送出去的 2 条得算进汇总');
  assert.equal(out.arbiter.pass, 1);
});

test('defaultProviderFromDump：只认 agent-default-model 那一段的 provider', () => {
  const dump = [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: example-provider',
    '    model: example-model',
    '- id: jobs',
    '  config:',
    '    provider: 别认这段',
  ].join('\n');
  assert.equal(defaultProviderFromDump(dump), 'example-provider');
  assert.equal(defaultProviderFromDump("  provider: 没有那段\n"), '');
  assert.equal(defaultProviderFromDump(''), '');
});
