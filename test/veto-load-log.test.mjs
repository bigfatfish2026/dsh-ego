/**
 * 否决台账加载打点：让「账本到底读没读、读了几条」看得见。
 *
 * 盯四件事：
 *   1. formatVetoLoadLine 的四种形态（正常 / 不存在 / 空账本 / 读失败）逐字对齐；
 *   2. reporter 去重：同 mtime + 字节数不重复打，mtime 或字节数一变就重打；
 *   3. 打点自己抛异常不影响 checkVeto；
 *   4. 源码断言：打点在 getVetoLedger 里、在缓存命中之后，不在每拍热路径无条件打。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkVeto,
  createVetoLoadReporter,
  formatVetoLoadLine,
  loadVeto,
} from '../lib/veto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// getVetoLedger / vetoPlanFrom 已搬到 lib/engines/adjudicator.js：
// 这两个函数在同一份源码里，切片照旧从 getVetoLedger 切到 vetoPlanFrom
const INDEX_SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'engines', 'adjudicator.js'), 'utf8');
const VETO_SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'veto.js'), 'utf8');

const NOW = Date.parse('2026-11-11T12:00:00Z');
const COMBO = 'inspect|config→edit-config|config';
const ROOT = process.env.DSH_EGO_ROOT || path.join(os.homedir(), 'fatfish');
const OBJECT = `${ROOT}/plugins/app/cordis.patch.yml`;

function tmpFile(name = 'veto.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-veto-load-'));
  return path.join(dir, name);
}

function entry(over = {}) {
  return {
    ts: NOW - 3 * 86400_000,
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

function writeLedger(file, lines) {
  fs.writeFileSync(file, lines.map((one) => (typeof one === 'string' ? one : JSON.stringify(one))).join('\n') + '\n', 'utf8');
}

/** 固定 mtime（ms 精度），让「同 mtime 再读」可复现。 */
function setMtime(file, ms) {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

function reporterFixture() {
  const lines = [];
  const report = createVetoLoadReporter({ log: (line) => lines.push(line) });
  return { lines, report };
}

/* ── 1. 四种日志形态 ───────────────────────────────────────── */

test('打点格式：3 条 + 坏行 1 → 条数 / 跳过 / 字节 / 路径 都对', () => {
  const file = tmpFile();
  writeLedger(file, [entry(), entry({ ticketId: 't-2', objectNames: [`${ROOT}/a.yml`] }), entry({ ticketId: 't-3', objectNames: [`${ROOT}/b.yml`] }), '{坏行']);
  const bytes = fs.statSync(file).size;
  const ledger = loadVeto(file, { now: NOW });
  assert.equal(formatVetoLoadLine(ledger, { bytes }), `veto_load:3 条｜跳过 1 行｜${bytes} 字节｜${file}`);
});

test('打点格式：坏行 0 时不写「跳过」那截', () => {
  const file = tmpFile();
  writeLedger(file, [entry(), entry({ ticketId: 't-2', objectNames: [`${ROOT}/a.yml`] })]);
  const bytes = fs.statSync(file).size;
  const ledger = loadVeto(file, { now: NOW });
  const line = formatVetoLoadLine(ledger, { bytes });
  assert.equal(line, `veto_load:2 条｜${bytes} 字节｜${file}`);
  assert.ok(!line.includes('跳过'));
});

test('打点格式：文件不存在 → veto_load:文件不存在', () => {
  const file = tmpFile();
  const line = formatVetoLoadLine(loadVeto(file, { now: NOW }), { bytes: null });
  assert.equal(line, `veto_load:文件不存在｜${file}`);
});

test('打点格式：0 字节 → veto_load:0 条｜空账本', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '', 'utf8');
  const bytes = fs.statSync(file).size;
  const ledger = loadVeto(file, { now: NOW });
  assert.equal(bytes, 0);
  assert.equal(formatVetoLoadLine(ledger, { bytes }), `veto_load:0 条｜空账本｜${file}`);
});

test('打点格式：读失败（EISDIR）→ veto_load:读失败｜路径｜错误一句话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-veto-load-dir-'));
  const ledger = loadVeto(dir, { now: NOW });
  assert.equal(ledger.exists, true, 'stat 成功，读才失败');
  assert.ok(ledger.readError, '读失败要留错误信息给打点');
  const line = formatVetoLoadLine(ledger, { bytes: fs.statSync(dir).size });
  assert.match(line, /^veto_load:读失败｜/);
  assert.ok(line.includes(dir));
  assert.ok(!line.includes('\n'), '错误一句话不能带换行');
});

/* ── 2. 真实读盘：首次打一行，同 mtime 不重打，改了重打 ───────── */

test('首次读打一行，同 mtime 二次读不再打', () => {
  const file = tmpFile();
  writeLedger(file, [entry()]);
  setMtime(file, 1_700_000_000_000);
  const { lines, report } = reporterFixture();

  const first = loadVeto(file, { now: NOW });
  report(first, { bytes: fs.statSync(file).size });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^veto_load:1 条｜\d+ 字节｜/);

  const second = loadVeto(file, { now: NOW });
  report(second, { bytes: fs.statSync(file).size });
  assert.equal(lines.length, 1, '同一份文件反复读不重复打');
});

test('改文件后再读重打，条数更新', () => {
  const file = tmpFile();
  writeLedger(file, [entry()]);
  setMtime(file, 1_700_000_000_000);
  const { lines, report } = reporterFixture();
  report(loadVeto(file, { now: NOW }), { bytes: fs.statSync(file).size });

  writeLedger(file, [entry(), entry({ ticketId: 't-2', objectNames: [`${ROOT}/a.yml`] })]);
  setMtime(file, 1_700_000_005_000);
  report(loadVeto(file, { now: NOW }), { bytes: fs.statSync(file).size });

  assert.equal(lines.length, 2);
  assert.match(lines[1], /^veto_load:2 条｜\d+ 字节｜/);
});

test('mtime 不变但字节数变了，也要重打（缓存键含字节数）', () => {
  const file = tmpFile();
  writeLedger(file, [entry()]);
  setMtime(file, 1_700_000_000_000);
  const { lines, report } = reporterFixture();
  report(loadVeto(file, { now: NOW }), { bytes: fs.statSync(file).size });

  writeLedger(file, [entry(), entry({ ticketId: 't-2', objectNames: [`${ROOT}/a.yml`] })]);
  setMtime(file, 1_700_000_000_000); // 刻意恢复同一 mtime
  const ledger = loadVeto(file, { now: NOW });
  assert.equal(ledger.mtimeMs, 1_700_000_000_000);
  report(ledger, { bytes: fs.statSync(file).size });

  assert.equal(lines.length, 2);
  assert.match(lines[1], /^veto_load:2 条｜/);
});

test('文件不存在只打一次', () => {
  const file = tmpFile();
  const { lines, report } = reporterFixture();
  report(loadVeto(file, { now: NOW }), { bytes: null });
  report(loadVeto(file, { now: NOW }), { bytes: null });
  assert.deepEqual(lines, [`veto_load:文件不存在｜${file}`]);
});

test('不存在 → 空文件 → 有内容：状态变了每次都打', () => {
  const file = tmpFile();
  const { lines, report } = reporterFixture();
  report(loadVeto(file, { now: NOW }), { bytes: null });

  fs.writeFileSync(file, '', 'utf8');
  report(loadVeto(file, { now: NOW }), { bytes: 0 });

  writeLedger(file, [entry()]);
  report(loadVeto(file, { now: NOW }), { bytes: fs.statSync(file).size });

  assert.deepEqual(lines.map((line) => line.split('｜')[0]), [
    'veto_load:文件不存在',
    'veto_load:0 条',
    'veto_load:1 条',
  ]);
});

test('坏行：条数与「跳过 N 行」都对（真实读盘）', () => {
  const file = tmpFile();
  writeLedger(file, [entry(), '{坏行', entry({ ticketId: 't-2', objectNames: [`${ROOT}/a.yml`] })]);
  const { lines, report } = reporterFixture();
  report(loadVeto(file, { now: NOW }), { bytes: fs.statSync(file).size });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('veto_load:2 条｜跳过 1 行｜'), lines[0]);
});

/* ── 3. 打点自己坏了不能影响判定 ─────────────────────────── */

test('打点函数抛异常 → 静默跳过，checkVeto 照常判', () => {
  const file = tmpFile();
  writeLedger(file, [entry()]);
  const ledger = loadVeto(file, { now: NOW });
  const report = createVetoLoadReporter({
    log: () => {
      throw new Error('日志写坏了');
    },
    format: () => {
      throw new Error('拼串坏了');
    },
  });
  assert.doesNotThrow(() => report(ledger, { bytes: fs.statSync(file).size }));
  assert.equal(report(ledger, { bytes: fs.statSync(file).size }), '');

  const plan = { comboKey: COMBO, objectNames: [OBJECT], objectKind: 'config', actionPrimitive: 'edit-config' };
  const verdict = checkVeto(plan, loadVeto(file, { now: NOW }), { now: NOW });
  assert.equal(verdict.ok, false, '打点坏了不影响否决判定');
  assert.equal(verdict.hit.rule, 'combo');
});

test('log 抛异常时 reporter 不往外抛（只有 format 正常）', () => {
  const file = tmpFile();
  writeLedger(file, [entry()]);
  const report = createVetoLoadReporter({
    log: () => {
      throw new Error('日志写坏了');
    },
  });
  assert.doesNotThrow(() => report(loadVeto(file, { now: NOW }), { bytes: fs.statSync(file).size }));
});

/* ── 4. 源码断言：打点在 getVetoLedger 里、不在每拍无条件打 ─────── */

test('源码：veto_load 只在 getVetoLedger 的读路径里，缓存命中先 return', () => {
  const start = INDEX_SOURCE.indexOf('function getVetoLedger');
  const end = INDEX_SOURCE.indexOf('function vetoPlanFrom');
  assert.ok(start > 0 && end > start, 'getVetoLedger 和 vetoPlanFrom 的源码位置要能切出来');
  const body = INDEX_SOURCE.slice(start, end);
  assert.ok(body.includes('reportVetoLoad(ledger'), '打点在 getVetoLedger 里');
  assert.ok(body.includes('if (ledger.skipped > 0) log('), 'veto_skip 原样保留');

  const cacheReturn = body.indexOf('if (vetoCache.ledger && vetoCache.key === cacheKey) return vetoCache.ledger;');
  const reportCall = body.indexOf('reportVetoLoad(ledger, { bytes })');
  assert.ok(cacheReturn > 0, '沿用按 mtime + 字节数的缓存');
  assert.ok(reportCall > cacheReturn, '缓存命中直接 return，打点只在真重读时走');

  assert.ok(!INDEX_SOURCE.includes('veto_load:'), '日志格式只在 lib/veto.js，不在每拍热路径上手拼');
  assert.ok(VETO_SOURCE.includes('export function formatVetoLoadLine'));
  assert.ok(VETO_SOURCE.includes('export function createVetoLoadReporter'));
  assert.ok(VETO_SOURCE.includes("key = 'missing'"));
  assert.match(VETO_SOURCE, /key = `ok:\$\{Number\(ledger\?\.mtimeMs\)/, '去重键含 mtime');
  assert.ok(VETO_SOURCE.includes('Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes))'), '去重键含字节数');
});
