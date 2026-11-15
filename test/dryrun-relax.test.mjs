/**
 * dryRun 放宽规则的遗留单测（2026-11-11 起 ego 不再自己开票）。
 *
 * 放宽逻辑原来用在 ego 自己开写类票那一路：可自动回滚 + undo 给了具体命令时
 * 把 dryRun.ok=false 改成 true。现在 ego 只向主会话提申请，intent 原样透传，
 * 放宽与否交给主会话判断；relaxDryRun 函数本身暂时留着，但这条路径没有调用点。
 *   node --test test/dryrun-relax.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicketOpener, relaxDryRun, routeDecision } from '../lib/route.js';
import { defaultState } from '../lib/state.js';

const T0 = new Date('2026-11-11T04:50:00Z').getTime();

function fakeAgent() {
  const sent = [];
  return {
    sent,
    session: { id: 'main' },
    status: 'idle',
    async followup(message) {
      sent.push(message);
    },
  };
}

function opener() {
  const agent = fakeAgent();
  const logs = [];
  const open = createTicketOpener({
    findAgent: () => agent,
    targetId: () => 'main-session',
    state: defaultState(),
    save: () => {},
    log: (line) => logs.push(line),
    openTimeoutMs: 5000,
  });
  return { open, agent, logs };
}

/** 取申请正文里的 intent 那一行，解析回对象 */
function sentIntent(agent) {
  assert.equal(agent.sent.length, 1, '主会话该收到一条申请');
  const line = agent.sent[0].content[0].text.split('\n').find((one) => one.startsWith('intent: '));
  assert.ok(line, '申请里必须有 intent 一行');
  return JSON.parse(line.slice('intent: '.length));
}

const WRITE_INTENT = {
  reversibility: 'auto',
  impact: { paths: ['lib/window.js'], services: [], remotes: [] },
  dryRun: { ok: false, detail: '需在进程内实读一次验证' },
  undo: { kind: 'git-checkout', ref: 'lib/window.js', howto: 'git checkout -- lib/window.js' },
};

const RELAXED = 'dryrun_relaxed:auto｜undo:';

test('auto + undo 给了具体命令：ego 也不再放宽，dryRun.ok=false 原样透传', async () => {
  const { open, agent, logs } = opener();
  const result = await open(
    { goal: '把 lib/window.js:12 的超时改成 30 秒', brief: '改超时', intent: WRITE_INTENT },
    T0,
    { reason: '这行超时把链路拖慢' },
  );
  assert.equal(result.ok, true);

  const intent = sentIntent(agent);
  assert.equal(intent.dryRun.ok, false, '放不放宽归主会话，ego 不许自己改');
  assert.equal(intent.dryRun.detail, '需在进程内实读一次验证', '原说明不许覆盖');
  assert.equal(intent.reversibility, 'auto');
  assert.equal(intent.undo.kind, 'git-checkout');
  assert.equal(intent.undo.howto, 'git checkout -- lib/window.js');
  assert.deepEqual(intent.impact.paths, ['lib/window.js']);

  assert.equal(logs.some((one) => one.startsWith(RELAXED)), false, 'ego 侧不许再记放行日志');
  const note = agent.sent[0].content[0].text.split('\n').at(-1);
  assert.ok(note.includes('git checkout -- lib/window.js'), `note 要把 undo 命令写清：${note}`);
  assert.ok(note.includes('可自动回滚'));
});

test('reversibility=none / manual / 空话 undo：dryRun.ok 都保持 false 原样', async () => {
  for (const intent of [
    { ...WRITE_INTENT, reversibility: 'none' },
    { ...WRITE_INTENT, reversibility: 'manual' },
    { ...WRITE_INTENT, undo: { kind: '', ref: '', howto: 'revert it' } },
    { ...WRITE_INTENT, undo: { kind: '', ref: '', howto: '出问题就手动处理一下' } },
    { ...WRITE_INTENT, undo: { kind: '', ref: '', howto: '撤销那个改动重新来过' } },
  ]) {
    const { open, agent } = opener();
    await open({ goal: '改 lib/window.js 的超时', brief: '改超时', intent }, T0);
    assert.equal(sentIntent(agent).dryRun.ok, false);
  }
});

test('dryRun 本来就 ok=true：不动它', async () => {
  const { open, agent } = opener();
  await open(
    {
      goal: '连跑一遍测试',
      brief: '跑测试',
      intent: { ...WRITE_INTENT, dryRun: { ok: true, detail: 'node --test test/route.test.mjs' } },
    },
    T0,
  );
  const intent = sentIntent(agent);
  assert.equal(intent.dryRun.ok, true);
  assert.equal(intent.dryRun.detail, 'node --test test/route.test.mjs');
});

test('routeDecision 那条路也一样原样透传（do → openTicket → followup）', async () => {
  const { open, agent, logs } = opener();
  const result = await routeDecision(
    { action: 'do', ticket: { goal: '把超时改成 30 秒', brief: '改超时', intent: WRITE_INTENT }, reason: '该改' },
    { ask: async () => ({ ok: true }), openTicket: (ticket, meta) => open(ticket, T0, meta) },
  );
  assert.equal(result.ok, true);
  assert.equal(sentIntent(agent).dryRun.ok, false);
  assert.equal(logs.some((one) => one.startsWith(RELAXED)), false);
});

test('relaxDryRun 是纯函数：不改传进来的对象，重复调用不会叠一层「原说明」', () => {
  const once = relaxDryRun(WRITE_INTENT);
  assert.equal(WRITE_INTENT.dryRun.ok, false, '原对象不许被就地改写');
  assert.equal(WRITE_INTENT.dryRun.detail, '需在进程内实读一次验证');

  const twice = relaxDryRun(once, { log: () => {} });
  assert.equal(twice.dryRun.ok, true);
  assert.equal(twice.dryRun.detail, once.dryRun.detail, '已经放行过的不再拼一遍');
});

test('relaxDryRun 对空的 / 没有 dryRun 的 intent 原样返回', () => {
  assert.equal(relaxDryRun(null), null);
  assert.equal(relaxDryRun(undefined), undefined);
  assert.deepEqual(relaxDryRun({}), {}, '没 dryRun 栏 → 原样返回');
});
