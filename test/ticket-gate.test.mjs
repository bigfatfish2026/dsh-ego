/**
 * 票台闸的查询与判定。
 *
 * 覆盖：服务 payload / select 两种读数、服务坏了退只读 sqlite、库/表打不开按不空、
 * 只读打开不建 WAL 不改文件、未 checkpoint 的 WAL 跨进程也读得到（真子进程）、
 * 两个来源都探且取大者、固定日志文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  OPEN_STATUSES,
  countOpenFromDb,
  countOpenFromService,
  createTicketProbe,
  formatBusyLog,
  formatProbeLog,
  formatUnknownLog,
} from '../lib/ticket-gate.js';

/** 建一个最小票库：只有 id/state 两列，够投影查询用。 */
function makeTicketDb(states) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-tickets-'));
  const file = path.join(dir, 'tickets.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE tickets (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO tickets(id, state) VALUES(?, ?)');
  states.forEach((state, i) => insert.run(`t-${i}`, state));
  db.close();
  return { dir, file };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const PROBE_HREF = new URL('../lib/ticket-gate.js', import.meta.url).href;

/** 在另一个进程里跑真探针，模拟「dispatcher 写库 / ego 进程读库」的真实关系。 */
function probeInChildProcess(file) {
  const code = `
    const { createTicketProbe } = await import(${JSON.stringify(PROBE_HREF)});
    const result = await createTicketProbe({ dbPath: process.argv[1] })();
    console.log(JSON.stringify(result));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code, file], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

test('服务读数：payload counts.openTotal 直接用；没有 counts 就按 tickets 状态过滤', () => {
  assert.equal(countOpenFromService({ payload: () => ({ counts: { openTotal: 3 } }) }), 3);
  const tickets = [{ status: 'open' }, { status: 'running' }, { status: 'waiting' }, { status: 'blocked' }, { status: 'done' }];
  assert.equal(countOpenFromService({ payload: () => ({ counts: {}, tickets }) }), 4);
  assert.equal(countOpenFromService({ payload: () => ({ counts: { openTotal: 0 }, tickets: [] }) }), 0);
});

test('服务读数：没有 payload 的老实现退到 select({ open: true })', () => {
  assert.equal(
    countOpenFromService({
      select: (selection) => {
        assert.deepEqual(selection, { open: true });
        return [{ status: 'running' }, { status: 'done' }];
      },
    }),
    1,
  );
});

test('只读连接能读到未 checkpoint 的 WAL（跨进程，写连接不关）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-wal-'));
  const file = path.join(dir, 'tickets.db');
  const writer = new DatabaseSync(file);
  try {
    // 制造生产同款状态：WAL 模式、写入已提交、写连接一直开着、不 checkpoint
    writer.exec('PRAGMA journal_mode=WAL');
    writer.exec('CREATE TABLE tickets (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    const insert = writer.prepare('INSERT INTO tickets(id, state) VALUES(?, ?)');
    insert.run('a', 'running');
    insert.run('b', 'open');
    insert.run('c', 'done');
    assert.ok(fs.statSync(`${file}-wal`).size > 0, 'WAL 里确实有还没合并的东西');
    assert.ok(fs.statSync(`${file}-shm`).size > 0, 'shm 在');

    assert.equal(await countOpenFromDb(file), 2, '只读连接必须看到 WAL 里的两张未终态');

    const result = await createTicketProbe({ dbPath: file })();
    assert.equal(result.busy, true, 'WAL 里有票就不能放行');
    assert.equal(result.count, 2);
    assert.equal(result.source, 'sqlite');

    const child = probeInChildProcess(file);
    assert.deepEqual(
      { busy: child.busy, count: child.count, source: child.source },
      { busy: true, count: 2, source: 'sqlite' },
      '另一个进程只读也要读到同样的数（dispatcher 写、ego 读就是这个关系）',
    );
  } finally {
    writer.close();
    cleanup(dir);
  }
});

test('只读打开不建库、不写 WAL、不改文件 mtime', async () => {
  const { dir, file } = makeTicketDb([...OPEN_STATUSES, 'done', 'dropped']);
  const before = fs.statSync(file).mtimeMs;
  try {
    assert.equal(await countOpenFromDb(file), 4, 'open/running/waiting/blocked 各一张，终态不计');
    assert.equal(fs.statSync(file).mtimeMs, before, '只读打开不该改库文件');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('-wal') || name.endsWith('-shm')),
      [],
      '只读打开不该建 WAL/SHM',
    );
  } finally {
    cleanup(dir);
  }
});

test('服务抛错就退只读库，state 列四态一张张数出来', async () => {
  const { dir, file } = makeTicketDb([...OPEN_STATUSES, 'done', 'dropped']);
  try {
    const probe = createTicketProbe({
      readService: () => ({ payload: () => { throw new Error('服务炸了'); } }),
      dbPath: file,
    });
    const result = await probe();
    assert.equal(result.busy, true);
    assert.equal(result.count, 4);
    assert.equal(result.source, 'sqlite');
    assert.match(result.detail, /sqlite=4/);
    assert.match(result.detail, /服务炸了/);
  } finally {
    cleanup(dir);
  }
});

test('服务缺失 + 库不存在：保守按不空，source=none，原因写清', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-tickets-'));
  try {
    const probe = createTicketProbe({
      readService: () => undefined,
      dbPath: path.join(dir, 'nope.db'),
    });
    const result = await probe();
    assert.equal(result.busy, true, '查不到票台必须按不空处理');
    assert.equal(result.unknown, true);
    assert.equal(result.source, 'none');
    assert.match(result.error, /没有 dispatcher\/tickets 服务/);
    assert.match(result.error, /读库失败/);
    assert.match(formatProbeLog(result), /^\[ego\] 票台探针 source=none count=0 busy=1（/);
  } finally {
    cleanup(dir);
  }
});

test('库打得开但没有 tickets 表：同样按不空', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-tickets-'));
  const file = path.join(dir, 'tickets.db');
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    db.close();
    const probe = createTicketProbe({ readService: () => undefined, dbPath: file });
    const result = await probe();
    assert.equal(result.busy, true);
    assert.equal(result.unknown, true);
    assert.equal(result.source, 'none');
    assert.match(result.error, /no such table/i);
  } finally {
    cleanup(dir);
  }
});

test('两源都读到 0 才算空：busy false，走 sqlite（服务不在）', async () => {
  const { dir, file } = makeTicketDb(['done']);
  try {
    const probe = createTicketProbe({ readService: () => undefined, dbPath: file });
    const result = await probe();
    assert.equal(result.busy, false);
    assert.equal(result.count, 0);
    assert.equal(result.source, 'sqlite');
    assert.match(result.detail, /service 没拿到/);
    assert.match(result.detail, /sqlite=0/);
  } finally {
    cleanup(dir);
  }
});

test('服务谎报 0、库里有票：取大者，判定忙（source=sqlite）', async () => {
  const probe = createTicketProbe({
    readService: () => ({ payload: () => ({ counts: { openTotal: 0 } }) }),
    readDb: () => 2,
  });
  const result = await probe();
  assert.equal(result.busy, true, '一个源说 0 不算空，另一个源说 2 就得忙');
  assert.equal(result.count, 2);
  assert.equal(result.source, 'sqlite');
  assert.match(result.detail, /service=0/);
  assert.match(result.detail, /sqlite=2/);
});

test('库读到 0、服务说有票：也取大者（source=service）', async () => {
  const probe = createTicketProbe({
    readService: () => ({ payload: () => ({ counts: { openTotal: 3 } }) }),
    readDb: () => 0,
  });
  const result = await probe();
  assert.equal(result.busy, true);
  assert.equal(result.count, 3);
  assert.equal(result.source, 'service');
  assert.match(result.detail, /service=3／sqlite=0/);
});

test('两源都读到 0：放行，source 记 service（首选源同分优先）', async () => {
  const probe = createTicketProbe({
    readService: () => ({ payload: () => ({ counts: { openTotal: 0 } }) }),
    readDb: () => 0,
  });
  assert.deepEqual(await probe(), {
    busy: false,
    count: 0,
    source: 'service',
    detail: 'service=0／sqlite=0',
  });
});

test('两个源都炸：source=none、busy true，日志一行写清两边原因', async () => {
  const probe = createTicketProbe({
    readService: () => ({ payload: () => { throw new Error('服务炸了'); } }),
    readDb: () => { throw new Error('库也炸了'); },
  });
  const result = await probe();
  assert.equal(result.busy, true);
  assert.equal(result.unknown, true);
  assert.equal(result.source, 'none');
  const line = formatProbeLog(result);
  assert.match(line, /^\[ego\] 票台探针 source=none count=0 busy=1/);
  assert.match(line, /服务炸了/);
  assert.match(line, /库也炸了/);
});

test('日志文案：轮空/查不到/探针三套都固定可 grep', () => {
  assert.equal(formatBusyLog(2), '[ego] 轮空：票台有 2 张未终态票（open/running/waiting/blocked）');
  assert.equal(formatBusyLog('x'), '[ego] 轮空：票台有 0 张未终态票（open/running/waiting/blocked）');
  assert.equal(formatUnknownLog('读库也失败：CANTOPEN'), '[ego] 轮空：票台查不到（读库也失败：CANTOPEN），按不空处理');
  assert.equal(formatUnknownLog(''), '[ego] 轮空：票台查不到（没拿到原因），按不空处理');
  assert.equal(
    formatProbeLog({ busy: true, count: 2, source: 'service', detail: 'service=2／sqlite=2' }),
    '[ego] 票台探针 source=service count=2 busy=1（service=2／sqlite=2）',
  );
  assert.equal(
    formatProbeLog({ busy: false, count: 0, source: 'sqlite', detail: 'service 没拿到／sqlite=0' }),
    '[ego] 票台探针 source=sqlite count=0 busy=0（service 没拿到／sqlite=0）',
  );
  assert.equal(formatProbeLog({ busy: true, count: 0, source: 'none' }), '[ego] 票台探针 source=none count=0 busy=1');
});
