/**
 * 否决台账（裁决器·第二道关）单测。
 *
 * 覆盖面：空账 / 坏行降级 / V1 combo 命中 / V2 action 计数 / V3 升级 / 单段读 /
 * 同票去重 / TTL 60 天 / 对象名归一 / 脱敏 / 容量策略（稿里明确不淘汰）/ 接线顺序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VETO_WINDOW_DAYS,
  checkVeto,
  loadVeto,
  normalizeObjectName,
  recordVeto,
  redactVetoText,
  selectRecentVeto,
} from '../lib/veto.js';
import { buildJudgePrompt } from '../lib/judge.js';
import { runRewriteLoop } from '../lib/rewrite.js';

const DAY = 86400_000;
const NOW = Date.parse('2026-11-11T12:00:00Z');
const COMBO = 'inspect|config→edit-config|config';
const ROOT = process.env.DSH_EGO_ROOT || path.join(os.homedir(), 'fatfish');
const OBJECT = `${ROOT}/plugins/app/cordis.patch.yml`;

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-veto-'));
  return path.join(dir, 'veto.jsonl');
}

function writeLines(file, entries) {
  fs.writeFileSync(file, `${entries.map((one) => JSON.stringify(one)).join('\n')}\n`, 'utf8');
}

function vetoEntry(over = {}) {
  return {
    ts: NOW - 3 * DAY,
    ticketId: 't-1',
    comboKey: COMBO,
    objectNames: [OBJECT],
    readPrimitive: 'inspect',
    objectKind: 'config',
    actionPrimitive: 'edit-config',
    brief: '补上 boot 分区磁盘监控',
    reason: '固件分区不会写满，不用进磁盘监控',
    verdict: 'dropped',
    ...over,
  };
}

const PLAN = {
  comboKey: COMBO,
  objectNames: [OBJECT],
  readPrimitive: 'inspect',
  objectKind: 'config',
  actionPrimitive: 'edit-config',
  brief: '',
};

test('空台账：文件不存在也放行，不抛', () => {
  const file = tmpFile();
  const ledger = loadVeto(file);
  assert.deepEqual(ledger.entries, []);
  assert.equal(ledger.exists, false);
  const verdict = checkVeto(PLAN, ledger, { now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.hit, null);
  assert.equal(selectRecentVeto(ledger, { now: NOW }).length, 0);
});

test('坏行 / 非对象 / 缺字段跳过，其余行照常判', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    [
      '{坏 json',
      'null',
      JSON.stringify({ ts: NOW, comboKey: COMBO }),
      JSON.stringify(vetoEntry()),
    ].join('\n'),
    'utf8',
  );
  const ledger = loadVeto(file);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.skipped, 3);
  const verdict = checkVeto(PLAN, ledger, { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hit.rule, 'combo');
});

test('V1 combo + 对象命中：拒，hit.rule=combo', () => {
  const file = tmpFile();
  writeLines(file, [vetoEntry()]);
  const verdict = checkVeto(PLAN, loadVeto(file), { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hit.rule, 'combo');
  assert.equal(verdict.hit.ticketId, 't-1');
  assert.equal(verdict.hit.count, 1);
  assert.ok(verdict.reason.includes('否过这个方向'));
  assert.ok(verdict.reason.includes('固件分区'));
});

test('combo 相同但对象名无交集：不拒', () => {
  const file = tmpFile();
  writeLines(file, [vetoEntry()]);
  const verdict = checkVeto(
    { ...PLAN, objectNames: [`${ROOT}/plugins/other/cordis.patch.yml`] },
    loadVeto(file),
    { now: NOW },
  );
  assert.equal(verdict.ok, true);
});

test('对象名写法不同也归一成同一个键：绝对路径与短路径命中', () => {
  assert.equal(normalizeObjectName(`${ROOT}/docs/x.md`), normalizeObjectName('docs/x.md'));
  const file = tmpFile();
  writeLines(file, [vetoEntry({ objectNames: [`${ROOT}/docs/x.md`] })]);
  const verdict = checkVeto({ ...PLAN, objectNames: ['docs/x.md'] }, loadVeto(file), { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hit.rule, 'combo');
});

test('V2 action：同对象类 + 同动作原语被两张不同票否 → 拒；一张不拒', () => {
  const one = tmpFile();
  writeLines(one, [vetoEntry({ objectNames: [`${ROOT}/a.yml`], comboKey: 'inspect|config→edit-config|config' })]);
  const planOther = {
    ...PLAN,
    comboKey: 'inspect|files→edit-config|config',
    objectNames: [`${ROOT}/b.yml`],
  };
  assert.equal(checkVeto(planOther, loadVeto(one), { now: NOW }).ok, true, '一张票不构成 V2');

  const two = tmpFile();
  writeLines(two, [
    vetoEntry({ ticketId: 't-1', objectNames: [`${ROOT}/a.yml`], comboKey: 'inspect|config→edit-config|config' }),
    vetoEntry({ ticketId: 't-2', objectNames: [`${ROOT}/b.yml`], comboKey: 'inspect|service→edit-config|config' }),
  ]);
  const verdict = checkVeto(planOther, loadVeto(two), { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hit.rule, 'action');
  assert.equal(verdict.hit.count, 2);
});

test('V3 升级：同方向三张不同票 → 拒，hit.rule=escalate', () => {
  const file = tmpFile();
  writeLines(file, [
    vetoEntry({ ticketId: 't-1', objectNames: [`${ROOT}/a.yml`], comboKey: 'inspect|config→edit-config|config' }),
    vetoEntry({ ticketId: 't-2', objectNames: [`${ROOT}/b.yml`], comboKey: 'inspect|files→edit-config|config' }),
    vetoEntry({ ticketId: 't-3', objectNames: [`${ROOT}/c.yml`], comboKey: 'inspect|config→edit-config|config' }),
  ]);
  const verdict = checkVeto(
    { ...PLAN, comboKey: 'inspect|files→edit-config|config', objectNames: [`${ROOT}/d.yml`] },
    loadVeto(file),
    { now: NOW },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hit.rule, 'escalate');
  assert.equal(verdict.hit.count, 3);
  assert.ok(verdict.reason.includes('可能不是点子错'));
});

test('同一张票写两行只算一次：V1 计数 1，V2 不因重复行凑够 2', () => {
  const file = tmpFile();
  writeLines(file, [vetoEntry(), vetoEntry({ ts: NOW - 1 * DAY })]);
  const ledger = loadVeto(file);
  assert.equal(ledger.entries.length, 2, '读侧不删重复行');
  const combo = checkVeto(PLAN, ledger, { now: NOW });
  assert.equal(combo.hit.count, 1);
  const other = checkVeto(
    { ...PLAN, comboKey: 'inspect|files→edit-config|config', objectNames: [`${ROOT}/other.yml`] },
    ledger,
    { now: NOW },
  );
  assert.equal(other.ok, true, '同一张票重复写不能凑成 V2 的 2 次');
});

test('TTL：61 天前的否决不再命中', () => {
  const file = tmpFile();
  writeLines(file, [vetoEntry({ ts: NOW - 61 * DAY })]);
  const verdict = checkVeto(PLAN, loadVeto(file), { now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(selectRecentVeto(loadVeto(file), { now: NOW }).length, 0);
  assert.equal(VETO_WINDOW_DAYS, 60, '窗口 60 天写死');
});

test('容量：稿里明确不做自动清理，文件只增、超窗记录不参与判定', () => {
  const file = tmpFile();
  writeLines(file, [
    vetoEntry({ ts: NOW - 61 * DAY, ticketId: 't-old' }),
    vetoEntry({ ts: NOW - 1 * DAY, ticketId: 't-new' }),
  ]);
  const ledger = loadVeto(file);
  assert.equal(ledger.entries.length, 2, '读侧保留全部行，不按容量淘汰');
  const before = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  const written = recordVeto(
    { ticketId: 't-3', comboKey: COMBO, objectNames: [OBJECT], objectKind: 'config', actionPrimitive: 'edit-config', reason: '再来一条' },
    { file, now: NOW },
  );
  assert.equal(written.ok, true);
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  assert.equal(after, before + 1, '只追加，不重写、不淘汰');
  // 只留超窗那条时，V1/V2 都不命中
  const oldOnly = tmpFile();
  writeLines(oldOnly, [vetoEntry({ ts: NOW - 61 * DAY })]);
  assert.equal(checkVeto(PLAN, loadVeto(oldOnly), { now: NOW }).ok, true);
});

test('单段读只走 V1：actionPrimitive 为空不进 V2/V3', () => {
  const file = tmpFile();
  writeLines(file, [
    vetoEntry({ ticketId: 't-1', comboKey: 'inspect|config→', actionPrimitive: '', objectNames: [`${ROOT}/a.yml`] }),
    vetoEntry({ ticketId: 't-2', comboKey: 'inspect|config→', actionPrimitive: '', objectNames: [`${ROOT}/b.yml`] }),
    vetoEntry({ ticketId: 't-3', comboKey: 'inspect|config→', actionPrimitive: '', objectNames: [`${ROOT}/c.yml`] }),
  ]);
  const verdict = checkVeto(
    { ...PLAN, comboKey: 'inspect|config→', objectNames: [`${ROOT}/d.yml`], actionPrimitive: '' },
    loadVeto(file),
    { now: NOW },
  );
  assert.equal(verdict.ok, true, '没有动作原语可归组，不触发 V2/V3');
});

test('verdict 别的值（done）忽略', () => {
  const file = tmpFile();
  writeLines(file, [vetoEntry({ verdict: 'done' })]);
  const ledger = loadVeto(file);
  assert.equal(ledger.entries.length, 0);
  assert.equal(checkVeto(PLAN, ledger, { now: NOW }).ok, true);
});

test('写入 → 读回 → 命中：recordVeto 的格式和读侧口径对齐', () => {
  const file = tmpFile();
  const written = recordVeto(
    {
      ticketId: 't-write',
      comboKey: COMBO,
      objectNames: [OBJECT],
      readPrimitive: 'inspect',
      objectKind: 'config',
      actionPrimitive: 'edit-config',
      brief: '补上 boot 分区磁盘监控',
      reason: '固件分区不会写满，不用进磁盘监控',
      verdict: 'dropped',
    },
    { file, now: NOW },
  );
  assert.equal(written.ok, true);
  const verdict = checkVeto(PLAN, loadVeto(file), { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hit.ticketId, 't-write');
});

test('写入侧脱敏：sk- 开头的 token 不落原文', () => {
  const file = tmpFile();
  const written = recordVeto(
    { ticketId: 't-secret', comboKey: COMBO, objectNames: [OBJECT], reason: `用 ${'sk-' + 'abcdefgh12345678'} 调接口`, brief: 'x' },
    { file, now: NOW },
  );
  assert.equal(written.ok, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('sk-' + 'abcdefgh12345678'), false);
  assert.ok(text.includes('***'));
  assert.equal(redactVetoText('ghp_abcdefghijk').includes('ghp_'), false);
  assert.equal(redactVetoText('github_pat_abcdefghijklmnop').includes('github_pat_'), false);
  assert.equal(redactVetoText('crsr_abcdefghijk').includes('crsr_'), false);
  assert.equal(redactVetoText('oc_abcdefghijk').includes('oc_'), false);
  // 中文否决语不动，别整句吃掉
  assert.equal(redactVetoText('固件分区不会写满，不用进磁盘监控'), '固件分区不会写满，不用进磁盘监控');
});

test('写入侧：config 类非绝对路径整行不进台账', () => {
  const file = tmpFile();
  const written = recordVeto(
    { ticketId: 't-bad', comboKey: COMBO, objectNames: ['cordis.patch.yml'], objectKind: 'config', reason: 'x' },
    { file, now: NOW },
  );
  assert.equal(written.ok, false);
  assert.equal(fs.existsSync(file), false, '拒掉的行不落盘');
});

test('selectRecentVeto：最多 5 条、按 ts 倒序、空账 []', () => {
  const file = tmpFile();
  writeLines(
    file,
    Array.from({ length: 6 }, (_, i) => vetoEntry({
      ticketId: `t-${i}`,
      ts: NOW - (i + 1) * DAY,
      objectNames: [`${ROOT}/${i}.yml`],
      comboKey: 'inspect|files→edit-config|config',
      reason: `原因 ${i}`,
    })),
  );
  const recent = selectRecentVeto(loadVeto(file), { now: NOW });
  assert.equal(recent.length, 5);
  assert.deepEqual(recent.map((one) => one.ticketId), ['t-0', 't-1', 't-2', 't-3', 't-4']);
  assert.equal(selectRecentVeto(loadVeto(tmpFile()), { now: NOW }).length, 0);
});

test('接线：runRewriteLoop 在 gate 之后、judge 之前查 veto，命中不进 judge', async () => {
  const file = tmpFile();
  writeLines(file, [vetoEntry()]);
  const ledger = loadVeto(file);
  let judgeCalls = 0;
  let stage2Calls = 0;
  const outcome = await runRewriteLoop({
    maxRewrite: 3,
    firstPrompt: 'first',
    rewritePrompt: () => 'rewrite',
    stage2: async () => {
      stage2Calls += 1;
      return {
        ok: true,
        plan: {
          pick: 'C01',
          idea: '补上 boot 分区磁盘监控',
          why: 'app-monitor 只列了一个挂载点',
          step1: { read: `${ROOT}/plugins/app/cordis.patch.yml`, verdict: 'continue' },
          step2: { change: '改 diskPaths', files: [OBJECT] },
          plan: { steps: ['P1×config'], files: [OBJECT] },
          object: { kind: 'config', value: OBJECT },
        },
      };
    },
    checkPlan: async () => ({ ok: true, reject: [], downgrade: [], unsupported: [], hits: [] }),
    checkVeto: () => checkVeto(PLAN, ledger, { now: NOW }),
    judge: async () => {
      judgeCalls += 1;
      return { ok: true, decision: { action: 'ask', text: 'x', ticket: null, reason: 'r' } };
    },
    buildProposal: (plan) => ({ ...plan, candidate: null }),
    log: () => {},
  });
  assert.equal(outcome.kind, 'vetoRejected');
  assert.equal(outcome.reason.includes('固件分区'), true);
  assert.equal(judgeCalls, 0, 'veto 命中这一拍不调 judge');
  assert.equal(stage2Calls, 1, '也不再打回重写');
});

test('接线源码：裁决器顺序 gate → veto → judge，runRound 把命中处置成 silent', () => {
  const rewriteSource = fs.readFileSync(new URL('../lib/rewrite.js', import.meta.url), 'utf8');
  const indexSource = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/adjudicator.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/round.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')].join('\n');
  const gateAt = rewriteSource.indexOf('await checkPlan(plan)');
  const vetoAt = rewriteSource.indexOf('await checkVeto(proposal)');
  const judgeAt = rewriteSource.indexOf('await judge(proposal)');
  assert.ok(gateAt > 0, '找不到 gate 调用');
  assert.ok(vetoAt > gateAt, 'veto 必须在 gate 之后');
  assert.ok(judgeAt > vetoAt, 'judge 必须在 veto 之后');
  assert.ok(indexSource.includes('checkVeto: (proposal) => checkVetoFor(proposal, nowMs)'));
  assert.ok(indexSource.includes('loadVeto(cfg.vetoPath'));
  assert.ok(indexSource.includes('veto_hit:'));
  assert.ok(indexSource.includes('veto 拒了这一拍，不动作'));
  assert.match(indexSource, /proposal\.vetoRejected/);
  assert.match(indexSource, /state\.lastAction = 'silent';[\s\S]{0,200}veto 拒了这一拍/);
  assert.ok(indexSource.includes('recentVeto: cfg.vetoEnabled ? selectRecentVeto'));
  assert.ok(indexSource.includes('vetoEnabled: true'));
});

test('judge 提示词：有台账出现最近被否方向，空台账整段不出现', () => {
  const bare = buildJudgePrompt({ idea: 'x', why: 'y', now: new Date(NOW) });
  assert.equal(bare.includes('最近 5 条被用户否掉的方向'), false);
  const withVeto = buildJudgePrompt({
    idea: 'x',
    why: 'y',
    now: new Date(NOW),
    recentVeto: [{ ts: NOW - DAY, brief: '给 app-monitor 加 /boot/firmware', reason: '固件分区不会写满，不用监控' }],
  });
  assert.ok(withVeto.includes('最近 5 条被用户否掉的方向'));
  assert.ok(withVeto.includes('别重提'));
  assert.ok(withVeto.includes('固件分区不会写满'));
  assert.ok(withVeto.includes('只能输出 silent'));
});
