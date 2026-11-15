/**
 * 三分支路由与开票申请执行器的单测。
 * 全是假实现：不连模型、不开票、不发消息。
 *
 * 2026-11-11 起 do 这一支改成「向主会话 followup 一条开票申请」，
 * ego 不再借主会话身份调 dispatch_open（源码断言在文件末尾）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TICKET_REQUEST_LIMIT,
  buildTicketRequest,
  createTicketOpener,
  normalizeTicket,
  routeDecision,
  ticketCallId,
} from '../lib/route.js';
import { defaultState } from '../lib/state.js';
import { createGate, parseDecisionReport } from '../lib/gate.js';

const T0 = new Date('2026-11-08T06:50:00Z').getTime();

function fakeAgent({ status = 'idle', error } = {}) {
  const sent = [];
  return {
    sent,
    session: { id: 'main' },
    status,
    async followup(message) {
      if (error) throw error;
      sent.push(message);
    },
  };
}

function opener(overrides = {}) {
  const state = overrides.state ?? defaultState();
  const saved = [];
  const logs = [];
  const agent = overrides.agent ?? fakeAgent();
  const open = createTicketOpener({
    findAgent: overrides.findAgent ?? (() => agent),
    targetId: overrides.targetId ?? (() => 'main-session'),
    state,
    save: () => saved.push(JSON.parse(JSON.stringify(state))),
    log: (line) => logs.push(line),
    flush: overrides.flush,
    dryRun: overrides.dryRun ?? false,
    openTimeoutMs: overrides.openTimeoutMs ?? 1000,
  });
  return { open, state, saved, logs, agent };
}

/** 递到主会话的那条申请正文 */
function requestBody(agent, index = 0) {
  assert.ok(agent.sent[index], `主会话应该收到一条申请，实际 ${agent.sent.length} 条`);
  const blocks = agent.sent[index].content;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  return blocks[0].text;
}

test('silent：谁都不叫，一句话都不发', async () => {
  const called = [];
  const result = await routeDecision(
    { action: 'silent', reason: '没什么' },
    {
      ask: async () => called.push('ask'),
      openTicket: async () => called.push('open'),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, 'silent');
  assert.deepEqual(called, [], 'silent 不许叫 ask，也不许叫 openTicket');
});

test('ask：把话交给 ask，不碰开票', async () => {
  const calls = [];
  const result = await routeDecision(
    { action: 'ask', text: '要不要把旧备份清了？' },
    {
      ask: async (text) => {
        calls.push(text);
        return { ok: true };
      },
      openTicket: async () => {
        throw new Error('不该走到这');
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, 'ask');
  assert.deepEqual(calls, ['要不要把旧备份清了？']);
});

test('do：把规整过的票和裁决理由一起交给 openTicket', async () => {
  const calls = [];
  const result = await routeDecision(
    { action: 'do', ticket: { goal: '补 TODO', brief: '' }, reason: '欠了三天' },
    {
      ask: async () => {
        throw new Error('不该走到这');
      },
      openTicket: async (ticket, meta) => {
        calls.push({ ticket, meta });
        return { ok: true, callId: 'proactive-2026-11-08-1' };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, 'do');
  assert.deepEqual(calls[0].ticket, { goal: '补 TODO', brief: '补 TODO' }, 'brief 空时用 goal 兜底');
  assert.equal(calls[0].meta.reason, '欠了三天', '裁决理由要带下去写进 note');
});

test('非法裁决：未知动作 / 空文本 / do 没目标都不做', async () => {
  const boom = () => {
    throw new Error('不该叫');
  };
  assert.equal((await routeDecision({ action: 'report' }, { ask: boom, openTicket: boom })).ok, false);
  assert.equal((await routeDecision({ action: 'ask', text: '  ' }, { ask: boom })).ok, false);
  assert.equal((await routeDecision({ action: 'do', ticket: {} }, { openTicket: boom })).ok, false);
});

test('normalizeTicket：brief 截到 34 列', () => {
  const ticket = normalizeTicket({ goal: '把那个三个月没人动的旧博客备份删掉吧', brief: '把那个三个月没人动的旧博客备份删掉吧' });
  assert.ok(ticket.brief.length <= 17, `汉字最多 17 个，实际 ${ticket.brief}`);
  assert.equal(normalizeTicket({ goal: '  ' }), null);
});

/* ── 申请正文：固定格式、固定顺序 ───────────────────────────── */

const ROUTE_INTENT = {
  reversibility: 'auto',
  impact: { paths: ['lib/window.js'], services: [], remotes: [] },
  dryRun: { ok: false, detail: '需在进程内实读一次验证' },
  undo: { kind: 'git-checkout', ref: 'lib/window.js', howto: 'git checkout -- lib/window.js' },
};

test('申请正文：首行标记 + callId/goal/brief/intent/note 五行，顺序固定', async () => {
  const { open, agent } = opener();
  const result = await open(
    { goal: '把 lib/window.js:12 的超时改成 30 秒', brief: '改超时', intent: ROUTE_INTENT },
    T0,
    { reason: '这行超时把整条链路拖慢' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.callId, 'proactive-2026-11-08-1');

  const text = requestBody(agent);
  const lines = text.split('\n');
  assert.equal(lines.length, 6, `正文固定六行，实际 ${lines.length}：\n${text}`);
  assert.equal(lines[0], '【开票申请·dsh-ego】');
  assert.equal(lines[1], 'callId: proactive-2026-11-08-1');
  assert.equal(lines[2], 'goal: 把 lib/window.js:12 的超时改成 30 秒');
  assert.equal(lines[3], 'brief: 改超时');
  assert.ok(lines[4].startsWith('intent: '), 'intent 一行必须在 brief 之后、note 之前');
  assert.ok(lines[5].startsWith('note: '), 'note 是最后一行');

  // 字段值必须是单行：原文里有换行也要压平，主会话按行解析才不破
  const flattened = buildTicketRequest({
    callId: 'proactive-2026-11-08-9',
    goal: '第一行\n第二行',
    brief: '票面\r\n两行',
    intent: ROUTE_INTENT,
    note: '为什么\n想开',
  }).split('\n');
  assert.equal(flattened.length, 6, '正文里不许出现额外换行');
  assert.equal(flattened[2], 'goal: 第一行 第二行');
  assert.equal(flattened[3], 'brief: 票面 两行');
  assert.equal(flattened[5], 'note: 为什么 想开');

  // 递给主会话的消息形状跟 ask 完全一样：user + text + source.kind=dsh-ego
  assert.equal(agent.sent[0].role, 'user');
  assert.equal(agent.sent[0].source.kind, 'dsh-ego');
  assert.equal('log' in agent.sent[0], false, '不许往主会话历史里塞 log');
});

test('申请里的 intent 是归一化后的 JSON 原文、单行', async () => {
  const { open, agent } = opener();
  await open({ goal: '改超时', brief: '改超时', intent: ROUTE_INTENT }, T0);
  const line = requestBody(agent).split('\n').find((one) => one.startsWith('intent: '));
  const parsed = JSON.parse(line.slice('intent: '.length));
  assert.equal(parsed.reversibility, 'auto');
  assert.deepEqual(parsed.impact.paths, ['lib/window.js']);
  assert.equal(parsed.dryRun.ok, false);
  assert.equal(parsed.dryRun.detail, '需在进程内实读一次验证');
  assert.equal(parsed.undo.howto, 'git checkout -- lib/window.js');
  assert.equal(line.includes('\n'), false);
});

test('note：一句为什么；dryRun 未过时写清 undo 命令和能不能撤', async () => {
  const { open, agent } = opener();
  await open(
    { goal: '改超时', brief: '改超时', intent: ROUTE_INTENT },
    T0,
    { reason: '这行超时把整条链路拖慢' },
  );
  const note = requestBody(agent).split('\n').at(-1);
  assert.ok(note.startsWith('note: 这行超时把整条链路拖慢'), `note 要带裁决理由：${note}`);
  assert.ok(note.includes('dryRun 未过'), '要说清 dryRun 没过');
  assert.ok(note.includes('git checkout -- lib/window.js'), `要写出 undo.howto：${note}`);
  assert.ok(note.includes('可自动回滚'), '要说明能不能撤');

  // 撤不回来的要直说，不许含糊
  const none = opener();
  await none.open(
    { goal: '推代码', brief: '推代码', intent: { ...ROUTE_INTENT, reversibility: 'none', undo: { kind: '', ref: '', howto: '' } } },
    T0,
  );
  const noneNote = requestBody(none.agent).split('\n').at(-1);
  assert.ok(noneNote.includes('撤不回来'), `none 要写清楚：${noneNote}`);

  // dryRun 本来就过了：note 只留为什么，不硬塞撤销说明
  const passed = opener();
  await passed.open(
    { goal: '跑测试', brief: '跑测试', intent: { ...ROUTE_INTENT, dryRun: { ok: true, detail: 'node --test' } } },
    T0,
    { reason: '该跑一次' },
  );
  assert.equal(requestBody(passed.agent).split('\n').at(-1), 'note: 该跑一次');
});

test('intent 原样透传：dryRun.ok=false 不被 ego 改写成 true', async () => {
  const { open, agent, logs } = opener();
  await open({ goal: '把 lib/window.js:12 的超时改成 30 秒', brief: '改超时', intent: ROUTE_INTENT }, T0);
  const line = requestBody(agent).split('\n').find((one) => one.startsWith('intent: '));
  const parsed = JSON.parse(line.slice('intent: '.length));
  assert.equal(parsed.dryRun.ok, false, '放宽与否交给主会话，ego 不许自己改');
  assert.equal(parsed.dryRun.detail, '需在进程内实读一次验证', '原说明也不许覆盖');
  assert.equal(logs.some((one) => one.startsWith('dryrun_relaxed')), false, 'ego 侧不再放宽');
});

test('同一 callId 不重复发：重放只递一份申请', async () => {
  const { open, state, agent, logs } = opener();
  const ticket = { goal: '补 TODO', brief: '补 TODO' };
  const first = await open(ticket, T0);
  const second = await open(ticket, T0 + 1000);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true, '第二遍要认出来是同一份申请');
  assert.equal(second.callId, first.callId);
  assert.equal(agent.sent.length, 1, '主会话只该收到一份，实际收到两份就是重复开票');
  assert.equal(state.ticketRequests.length, 1);
  assert.equal(state.ticketRequests[0].callId, first.callId);
  assert.ok(logs.some((one) => one.includes('ticket_request:skip')), '跳过要留痕');
});

test('没写 intent 的申请：intent 一行写 null，不编字段', async () => {
  const { open, agent } = opener();
  await open({ goal: '补 TODO', brief: '' }, T0);
  const lines = requestBody(agent).split('\n');
  assert.equal(lines[4], 'intent: null');
  assert.equal(lines[3], 'brief: 补 TODO', 'brief 空时用 goal 兜底');
});

test('已提记录有上限：超过 50 条丢最旧的，state 不会无限长', async () => {
  const { open, state } = opener();
  for (let index = 0; index <= TICKET_REQUEST_LIMIT; index += 1) {
    // 每份内容不一样 → 各拿一个 callId；agent 里会堆 51 条，记录只留最近 50 条
    await open({ goal: `补 TODO ${index}`, brief: `补 TODO ${index}` }, T0 + index);
  }
  assert.equal(state.ticketRequests.length, TICKET_REQUEST_LIMIT);
  assert.equal(state.ticketRequests[0].goal, '补 TODO 1', '最旧那条被丢');
});

test('ticketCallId：同内容沿用原 callId，换内容按 seq 新开', async () => {
  const state = defaultState();
  assert.equal(ticketCallId(state, T0, { goal: 'x', brief: 'x' }), 'proactive-2026-11-08-1');
  state.pendingTicketQueue = [{ id: 'p1', goal: 'x', brief: 'x', callId: 'proactive-2026-11-08-1', at: T0 }];
  assert.equal(ticketCallId(state, T0, { goal: 'x', brief: 'x' }), 'proactive-2026-11-08-1');
  assert.equal(ticketCallId(state, T0, { goal: 'y', brief: 'y' }), 'proactive-2026-11-08-2');
});

test('申请发出去打一行 sent 日志（callId + goal 前 60 字）', async () => {
  const { open, logs } = opener();
  await open({ goal: '把 lib/window.js:12 的超时改成 30 秒', brief: '改超时' }, T0);
  const line = logs.find((one) => one.startsWith('ticket_request:sent'));
  assert.ok(line, `要记一行 sent：${logs.join(' | ')}`);
  assert.ok(line.includes('callId:proactive-2026-11-08-1'));
  assert.ok(line.includes('goal:把 lib/window.js:12 的超时改成 30 秒'));
  assert.equal(line.split('\n').length, 1);
});

test('主会话不在活表：存 pendingTicket，不发 followup，不自建假会话', async () => {
  const { open, state, saved, logs } = opener({ findAgent: () => undefined });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(state.pendingTicketQueue.length, 1);
  assert.equal(state.pendingTicketQueue[0].goal, '补 TODO');
  assert.equal(state.pendingTicketQueue[0].at, T0);
  assert.ok(state.pendingTicketQueue[0].callId, 'callId 要落盘');
  assert.ok(saved.length > 0, 'pending 要落盘');
  assert.ok(logs.some((one) => one.startsWith('ticket_request:pending') && one.includes('主会话不在活表')));
});

test('主会话正忙：存 pending，下一拍再提', async () => {
  const agent = fakeAgent({ status: 'running' });
  const { open, state, logs } = opener({ agent });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.ok(result.detail.includes('正忙'));
  assert.equal(agent.sent.length, 0, '忙的时候不硬塞');
  assert.equal(state.pendingTicketQueue.length, 1);
  assert.ok(logs.some((one) => one.startsWith('ticket_request:pending') && one.includes('正忙')));
});

test('followup 抛错：当失败，pending 留着下一拍重试', async () => {
  const agent = fakeAgent({ error: new Error('入站路由炸了') });
  const { open, state, logs } = opener({ agent });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes('入站路由炸了'));
  assert.equal(state.pendingTicketQueue.length, 1, '没发出去就留着');
  assert.ok(state.pendingTicketQueue[0].callId);
  assert.ok(logs.some((one) => one.startsWith('ticket_request:pending') && one.includes('入站路由炸了')));
});

test('followup 超时：不挂死，算 pending', async () => {
  const agent = fakeAgent();
  agent.followup = () => new Promise(() => {});
  const { open, state, logs } = opener({ agent, openTimeoutMs: 30 });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes('超时'));
  assert.equal(state.pendingTicketQueue.length, 1);
  assert.ok(logs.some((one) => one.startsWith('ticket_request:pending') && one.includes('超时')));
});

test('pending 补发：存着的申请带上原 callId 和原理由，发成功才出队', async () => {
  const state = defaultState();
  const agent = fakeAgent();
  let alive = false;
  const open = createTicketOpener({
    findAgent: () => (alive ? agent : undefined),
    targetId: () => 'main-session',
    state,
    save: () => {},
    log: () => {},
    openTimeoutMs: 1000,
  });

  const first = await open(
    { goal: '把 lib/window.js:12 的超时改成 30 秒', brief: '改超时', intent: ROUTE_INTENT },
    T0,
    { reason: '这行超时把链路拖慢' },
  );
  assert.equal(first.pending, true);
  assert.equal(state.pendingTicketQueue[0].intent.reversibility, 'auto', '队列条目要存住 intent');
  assert.equal(state.pendingTicketQueue[0].reason, '这行超时把链路拖慢', '队列条目要存住理由');

  alive = true;
  const retried = await open(state.pendingTicketQueue[0], T0 + 1000, { reason: state.pendingTicketQueue[0].reason });
  assert.equal(retried.ok, true);
  assert.equal(retried.callId, first.callId, '补发沿用原 callId');
  assert.equal(state.pendingTicketQueue.length, 0, '发成功才出队');
  const text = requestBody(agent);
  assert.equal(text.split('\n')[1], `callId: ${first.callId}`);
  assert.ok(text.includes('note: 这行超时把链路拖慢'));
  assert.equal(text.split('\n').find((one) => one.startsWith('intent: ')).includes('"dryRun":{"ok":false'), true);
});

test('dryRun：只记日志，不 followup 主会话', async () => {
  const { open, agent, logs } = opener({ dryRun: true });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, true);
  assert.equal(result.dry, true);
  assert.equal(agent.sent.length, 0, 'dryRun 不许真发申请');
  assert.ok(logs.some((one) => one.includes('[dry]')));
});

test('none 的 do 在路由前被降级：一张申请都不提，failStreak 不涨', async () => {
  const none = { ...ROUTE_INTENT, reversibility: 'none' };
  const report = parseDecisionReport(
    JSON.stringify({ action: 'do', ticket: { goal: '把 lib/window.js:12 推上去', brief: '推代码', intent: none }, reason: '想推' }),
  );
  assert.equal(report.ok, true);

  const settled = createGate().settle(report.decision);
  assert.equal(settled.decision.action, 'ask');

  const said = [];
  let opened = 0;
  const result = await routeDecision(settled.decision, {
    ask: async (text) => {
      said.push(text);
      return { ok: true };
    },
    openTicket: async () => {
      opened += 1;
      return { ok: true };
    },
  });
  assert.equal(result.action, 'ask');
  assert.equal(result.ok, true);
  assert.equal(opened, 0, '撤不回来的事不许提开票申请');
  assert.equal(said.length, 1, '降级后是把决定交给人，不是静默丢掉');
  assert.ok(said[0].includes('撤不回来'));
});

/* ── 源码断言：ego 不再自己调 dispatch_open ───────────────────── */

test('route.js 里没有 dispatch_open 的 tools.execute，也没有 relaxDryRun 调用点', () => {
  const source = fs.readFileSync(new URL('../lib/route.js', import.meta.url), 'utf8');
  assert.equal(source.includes('dispatch_open'), false, 'ego 只提申请，开票动作归主会话');
  assert.equal(source.includes('tools.execute'), false, '不许再借主会话身份执行工具');
  assert.equal(source.includes('AbortSignal.timeout'), false, '申请走 followup，不再拼 tool-call');
  // relaxDryRun 定义留着（怕别处引用），但这条路径不许再调它
  assert.equal((source.match(/relaxDryRun\(/g) ?? []).length, 1, '只留函数定义那一处');
});
