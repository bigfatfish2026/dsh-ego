/**
 * 三分支路由与开票执行器的单测。
 * 全是假实现：不连模型、不开票、不发消息。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTicketOpener,
  normalizeTicket,
  routeDecision,
  ticketCallId,
} from '../lib/route.js';
import { defaultState } from '../lib/state.js';

const T0 = new Date('2026-11-08T06:50:00Z').getTime();

function fakeTools({ visible = true, reply, error, legacy = false } = {}) {
  const calls = [];
  const tools = {
    calls,
    async execute(input) {
      calls.push({ kind: 'execute', input });
      if (error) throw error;
      return reply ?? {
        results: [
          {
            callId: input.calls[0].id,
            result: { isError: false, content: [{ type: 'text', text: '票 t-abc12345-xyz9 已开' }] },
          },
        ],
      };
    },
  };
  // 现网宿主：存在性看 get（executable 是执行判据，条件注册会漏）
  if (!legacy) {
    tools.get = (name, agent) => {
      calls.push({ kind: 'get', name, agent });
      return visible ? { name } : undefined;
    };
  } else {
    // 老宿主没有 get：退回 executable
    tools.executable = (name, agent) => {
      calls.push({ kind: 'executable', name, agent });
      return visible ? { name } : undefined;
    };
  }
  return tools;
}

function opener(overrides = {}) {
  const state = overrides.state ?? defaultState();
  const saved = [];
  const logs = [];
  const tools = overrides.tools ?? fakeTools();
  const open = createTicketOpener({
    tools,
    findAgent: overrides.findAgent ?? (() => ({ session: { id: 'main' }, status: 'idle' })),
    targetId: overrides.targetId ?? (() => 'main-session'),
    state,
    save: () => saved.push(JSON.parse(JSON.stringify(state))),
    log: (line) => logs.push(line),
    dryRun: overrides.dryRun ?? false,
    openTimeoutMs: 5000,
  });
  return { open, state, saved, logs, tools };
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

test('do：把规整过的票交给 openTicket', async () => {
  const calls = [];
  const result = await routeDecision(
    { action: 'do', ticket: { goal: '补 TODO', brief: '' } },
    {
      ask: async () => {
        throw new Error('不该走到这');
      },
      openTicket: async (ticket) => {
        calls.push(ticket);
        return { ok: true, ticket: 't-1' };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, 'do');
  assert.deepEqual(calls, [{ goal: '补 TODO', brief: '补 TODO' }], 'brief 空时用 goal 兜底');
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

test('开票：调 dispatch_open、callId 稳定、不传 log（主会话历史不能脏）', async () => {
  const { open, state, tools } = opener();
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, true);
  assert.equal(result.ticket, 't-abc12345-xyz9');
  assert.equal(state.pendingTicketQueue.length, 0, '开完票要把 pending 清掉');

  const exec = tools.calls.find((call) => call.kind === 'execute');
  assert.ok(exec, '要真的调 tools.execute');
  assert.equal(exec.input.calls[0].name, 'dispatch_open');
  assert.equal('log' in exec.input, false, '传 log 会往主会话写 tool/call 事件');
  assert.equal(exec.input.agent.session.id, 'main');
  assert.deepEqual(JSON.parse(exec.input.calls[0].arguments), { goal: '补 TODO', brief: '补 TODO' });
  assert.ok(exec.input.signal instanceof AbortSignal, '要有超时信号');
});

test('同一张票重放：callId 不变（幂等），不会开第二张', async () => {
  const { open, state, tools } = opener();
  await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  const firstId = tools.calls.find((call) => call.kind === 'execute').input.calls[0].id;

  // 模拟「上一拍已经把 callId 落盘、但 execute 没走完」：pending 还在，同一条票再开一次
  state.pendingTicketQueue = [{ id: 'p1', goal: '补 TODO', brief: '补 TODO', callId: firstId, at: T0 }];
  state.pendingSeq = 1;
  await open({ goal: '补 TODO', brief: '补 TODO' }, T0 + 1000);
  const ids = tools.calls.filter((call) => call.kind === 'execute').map((call) => call.input.calls[0].id);
  assert.deepEqual(ids, [firstId, firstId], '两次调用同一个 callId');
  assert.equal(ticketCallId(defaultState(), T0, { goal: 'x', brief: 'x' }), 'proactive-2026-11-08-1');
});

test('主会话不在活表：存 pendingTicket，不自建假会话', async () => {
  const { open, state, saved } = opener({ findAgent: () => undefined });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(state.pendingTicketQueue.length, 1);
  assert.equal(state.pendingTicketQueue[0].goal, '补 TODO');
  assert.equal(state.pendingTicketQueue[0].at, T0);
  assert.ok(saved.length > 0, 'pending 要落盘');
});

test('看不见 dispatch_open：判失败、不调 execute，但票存起来等下一拍', async () => {
  const tools = fakeTools({ visible: false });
  const { open, state, saved, logs } = opener({ tools });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, false);
  assert.equal(result.pending, true, '看不见不等于丢掉，要走 pending 重试');
  assert.ok(result.detail.includes('dispatch_open'));
  assert.equal(tools.calls.some((call) => call.kind === 'execute'), false, '探不到就不许硬调');
  assert.equal(state.pendingTicketQueue.length, 1);
  assert.equal(state.pendingTicketQueue[0].goal, '补 TODO');
  assert.equal(state.pendingTicketQueue[0].at, T0);
  assert.ok(saved.length > 0, 'pending 要落盘');
  assert.ok(logs.some((line) => line.includes('看不见 dispatch_open')), `要记日志，实际：${logs.join(' | ')}`);
});

test('探得到 dispatch_open：走执行器，且是 get(主会话) 这条判据', async () => {
  const tools = fakeTools();
  const { open, state } = opener({ tools });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, true);
  const probe = tools.calls.find((call) => call.kind === 'get');
  assert.ok(probe, '要用 get 探存在性');
  assert.equal(probe.name, 'dispatch_open');
  assert.equal(probe.agent.session.id, 'main', '探的是主会话视角，不是全局裸视角');
  assert.equal(state.pendingTicketQueue.length, 0);
});

test('老宿主没有 get：退回 executable 探，照样能开票', async () => {
  const tools = fakeTools({ legacy: true });
  const { open } = opener({ tools });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, true);
  assert.ok(tools.calls.some((call) => call.kind === 'executable'));
});

test('dispatch_open 返回 isError：当失败，pending 留着等下次', async () => {
  const tools = fakeTools({
    reply: {
      results: [{ callId: 'x', result: { isError: true, content: [{ type: 'text', text: '票太多了（maxOpen）' }] } }],
    },
  });
  const { open, state } = opener({ tools });
  const result = await open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes('maxOpen'));
  assert.equal(state.pendingTicketQueue.length, 1, '失败时 callId 要留着');
  assert.ok(state.pendingTicketQueue[0].callId);
});

test('execute 抛错 / dryRun：都不算开成', async () => {
  const thrown = opener({ tools: fakeTools({ error: new Error('工具层炸了') }) });
  const failed = await thrown.open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(failed.ok, false);
  assert.ok(failed.detail.includes('工具层炸了'));

  const dryTools = fakeTools();
  const dry = opener({ tools: dryTools, dryRun: true });
  const dryResult = await dry.open({ goal: '补 TODO', brief: '补 TODO' }, T0);
  assert.equal(dryResult.ok, true);
  assert.equal(dryResult.dry, true);
  assert.equal(dryTools.calls.some((call) => call.kind === 'execute'), false, 'dryRun 不许真开票');
});
