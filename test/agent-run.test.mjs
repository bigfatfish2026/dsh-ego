/**
 * runAgent 的单测：注入假 create，验「建 → 塞提示词 → 取文本 → finally dispose」。
 * 一条都不连模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JUDGE_TIMEOUT_MS,
  PROPOSER_TIMEOUT_MS,
  REASONING_EFFORTS,
  UNLIMITED_MAX_TOKENS,
  assistantText,
  assistantTurns,
  extractJson,
  emptyReplyError,
  finishKind,
  normalizeReasoningEffort,
  openAgentSession,
  routeOptions,
  runAgent,
  selectAllow,
  turnEndError,
} from '../lib/agent-run.js';

function fakeAgent({ text = '{"ok":true}', hang = false, finish, turnEndError: turnEndMessage } = {}) {
  const events = [
    {
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text }] },
        stream: finish ? [{ type: 'finish', reason: { kind: finish } }] : [],
      },
    },
  ];
  // 一步都没跑起来时宿主的形状：没有 assistant 消息，只有 turn/end 带 error
  if (turnEndMessage) {
    events.push({
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: turnEndMessage } } },
    });
  }
  const agent = {
    status: 'idle',
    followups: [],
    session: {
      seq: 0,
      snapshotEvents: () => events,
    },
    followup(message) {
      agent.followups.push(message);
      agent.status = 'running';
    },
    whenIdle() {
      agent.status = 'idle';
      return hang ? new Promise(() => {}) : Promise.resolve();
    },
  };
  return agent;
}

function harness({ agent = fakeAgent(), createError, hang = false, visible, restrictError, mountError, presets } = {}) {
  const seen = { create: [], restrict: [], guards: [], mounts: [], disposed: 0, logs: [], unrestricted: 0 };
  const deps = {
    log: (line) => seen.logs.push(line),
    uuid: () => 'uuid-fixed',
    now: () => 1000,
    async create(options) {
      seen.create.push(options);
      if (createError) throw createError;
      const tools = {
        // 默认全可见；给 visible 数组就只认那些名字，模拟子 agent 的真实视角
        get: (name, scope) => {
          seen.gets ??= [];
          seen.gets.push({ name, scope });
          return !visible || visible.includes(name) ? { name } : undefined;
        },
        guard: (fn) => {
          seen.guards.push(fn);
          return () => {};
        },
        restrict: (filter) => {
          seen.restrict.push(filter);
          // 模拟宿主：名单里带未知名就抛；空名单永远收
          if (restrictError && (filter.allow ?? []).length > 0) throw restrictError;
          // 真实宿主返回的是「解除限制」的 disposer 函数（dsh-tools lib/index.js:467），
          // 不是带 commit 的对象——旧代码就是把这个函数当 setup 返回值返回去炸的
          return () => {
            seen.unrestricted += 1;
          };
        },
      };
      // 宿主 agentPresets 服务：默认 mount 成功并记下 id；给 mountError 就模拟档不存在，
      // 给 presets（含 null）就整体替换这个服务。
      const presetService = presets !== undefined
        ? presets
        : {
            async mount(ctx, id) {
              seen.mounts.push({ ctx, id });
              if (mountError) throw mountError;
            },
          };
      const get = (name) => (name === 'agentPresets' ? presetService : undefined);
      // setup 必须被调用：挂档 + 过滤 + restrict 都发生在里面，第二个参数是子 agent
      seen.setup = options.setup;
      // 复刻宿主 dsh-agent-loop 0.2.2-rc.1 lib/index.js:1574-1576：
      //   const setupCommit = await setup?.(agent.ctx, agent);
      //   setupCommit?.commit();
      // 假宿主不这么调，测试就看不见这次的崩法
      const setupResult = await options.setup({ tools, get }, { id: 'child-agent' });
      seen.setupResult = setupResult;
      setupResult?.commit();
      if (hang) agent.whenIdle = () => new Promise(() => {});
      return {
        agent,
        async dispose() {
          seen.disposed += 1;
        },
      };
    },
  };
  return { deps, seen, agent };
}

const base = {
  kind: 'proposer',
  prompt: '想一个点子',
  allow: ['read', 'memory_recall'],
  timeoutMs: 200,
  agentOptions: { provider: 'example-provider', model: 'example-model', maxTokens: 800 },
};

test('正常跑完：建 agent、restrict 一次、塞提示词、取到文本、dispose 一次', async () => {
  const { deps, seen, agent } = harness();
  const result = await runAgent(deps, base);

  assert.equal(result.ok, true);
  assert.equal(result.text, '{"ok":true}');
  assert.equal(seen.disposed, 1, 'dispose 必须调用一次');

  const created = seen.create[0];
  assert.equal(created.sessionId, 'uuid-fixed', 'sessionId 用裸 uuid');
  // meta 里不许出现 origin：dsh-subagent 的 rootOf 会把 origin === 'subagent' 判成
  // delegated，而 helper 不在 resident 表里，必抛 agent has no active runtime owner
  assert.equal('origin' in created.meta, false, 'helper 不能带 origin，否则 dsh-subagent 当成 delegated');
  assert.equal(created.meta.agentPreset, 'dsh-ego');
  assert.equal('parentAgent' in created, false, '临时 agent 不许挂 parentAgent');
  assert.deepEqual(created.agentOptions, { provider: 'example-provider', model: 'example-model', maxTokens: 800 });
  assert.deepEqual(seen.restrict, [{ allow: ['read', 'memory_recall'] }], 'restrict 只在 setup 里调一次');
  assert.deepEqual(seen.mounts.map((mount) => mount.id), ['dsh-ego'], '按 agentPreset 显式 mount 一次');

  assert.equal(agent.followups.length, 1);
  assert.equal(agent.followups[0].content[0].text, '想一个点子');
  assert.equal(agent.followups[0].source.kind, 'dsh-ego');
});

test('setup 返回的是 AgentSetupCommit：对象，且 commit 是可调用函数', async () => {
  const { deps, seen } = harness();
  await runAgent(deps, base);

  assert.equal(typeof seen.setupResult, 'object', 'setup 不能把 restrict 的 disposer 直接返回');
  assert.notEqual(seen.setupResult, null, 'setup 也不能返回 null');
  assert.equal(
    typeof seen.setupResult?.commit,
    'function',
    '返回值没带 commit，dsh-agent-loop lib/index.js:1576 的 setupCommit?.commit() 就是 TypeError',
  );
});

test('commit 调用后不抛、也不重复 restrict：限制在 setup 里已经即时生效', async () => {
  const { deps, seen } = harness({ visible: ['read'] });
  await runAgent(deps, { ...base, allow: ['read', 'memory_recall'] });

  assert.deepEqual(seen.restrict, [{ allow: ['read'] }], 'setup 阶段就该把筛后的 allow 挂上');
  assert.doesNotThrow(() => seen.setupResult.commit(), 'commit 抛了宿主会整次回滚');
  assert.deepEqual(seen.restrict, [{ allow: ['read'] }], 'commit 里不该再挂一次 restrict');
});

test('agentOptions 空着也照跑（配置没填全不至于炸）', async () => {
  const { deps, seen } = harness();
  const result = await runAgent(deps, { ...base, agentOptions: {} });
  assert.equal(result.ok, true);
  assert.equal(seen.disposed, 1);
});

test('开跑记一行「超时 N 秒」，收尾记耗时（下次看日志分得清是模型慢还是工具往返多）', async () => {
  const { timeoutMs, ...rest } = base;
  const { deps, seen } = harness();
  await runAgent(deps, { ...rest, kind: 'proposer' });
  assert.equal(PROPOSER_TIMEOUT_MS, 600_000, '提议器默认超时 10 分钟');
  assert.equal(JUDGE_TIMEOUT_MS, 180_000, '终审默认超时 3 分钟');
  assert.ok(
    seen.logs.some((line) => line === '提议器开跑（超时 600 秒）'),
    `要记开跑日志，实际：${seen.logs.join(' | ')}`,
  );
  assert.ok(
    seen.logs.some((line) => /^提议器跑完，耗时 \d+\.\d 秒$/.test(line)),
    `要记耗时日志，实际：${seen.logs.join(' | ')}`,
  );
});

test('超时日志写秒不写毫秒，失败那一路也记耗时', async () => {
  const { deps, seen } = harness({ hang: true });
  const result = await runAgent(deps, { ...base, kind: 'judge', timeoutMs: 40 });
  assert.equal(result.ok, false);
  assert.match(result.error, /超时（40 毫秒）/, `毫秒级写成毫秒，实际：${result.error}`);
  assert.ok(
    seen.logs.some((line) => /^终审失败，耗时 \d+\.\d 秒：超时/.test(line)),
    `失败也要记耗时，实际：${seen.logs.join(' | ')}`,
  );
});

test('whenIdle 不返回：超时判失败并 dispose', async () => {
  const { deps, seen } = harness({ hang: true });
  const result = await runAgent(deps, { ...base, timeoutMs: 40 });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('超时'), `实际：${result.error}`);
  assert.equal(seen.disposed, 1, '超时也要 dispose');
});

test('create 抛错：判失败，不崩，不假装成功', async () => {
  const { deps } = harness({ createError: new Error('names unknown global tool "foo"') });
  const result = await runAgent(deps, base);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('unknown global tool'));
});

test('没有 assistant 文本：判失败并 dispose', async () => {
  const { deps, seen } = harness({ agent: fakeAgent({ text: '   ' }) });
  const result = await runAgent(deps, base);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('assistant'));
  assert.equal(seen.disposed, 1);
});

test('assistantText：最后一条非空消息优先，空了退回流式增量', () => {
  const events = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧的' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新的' }] } } },
  ];
  assert.equal(assistantText(events), '新的');
  assert.equal(
    assistantText([{ type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: '流式' } }] } }]),
    '流式',
  );
  assert.equal(assistantText([]), '');
});

test('extractJson：括号配对，字符串里的括号不算', () => {
  assert.deepEqual(extractJson('前 {"a":"}"} 后'), { a: '}' });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson('没有括号'), null);
  assert.equal(extractJson('{"a": '), null);
});

test('白名单：子 agent 看不见的名字被剔掉，剔完记一条日志，不崩', async () => {
  const { deps, seen } = harness({ visible: ['read', 'memory_recall'] });
  const result = await runAgent(deps, { ...base, allow: ['read', 'read_image', 'web_fetch', 'memory_recall'] });

  assert.equal(result.ok, true, '剔掉未知名不该让这一段失败');
  assert.deepEqual(seen.restrict, [{ allow: ['read', 'memory_recall'] }], '只把看得见的交给 restrict');
  assert.equal(seen.gets.length, 4, '四条都要按子 agent 视角探一遍');
  assert.deepEqual(seen.gets[0].scope, { id: 'child-agent' }, '探的是子 agent 自己，不是全局裸视角');
  assert.ok(
    seen.logs.some((line) => line.includes('read_image') && line.includes('web_fetch') && line.includes('已剔掉')),
    `要记一条点名日志，实际：${seen.logs.join(' | ')}`,
  );
});

test('白名单全被剔掉：restrict 收到空 allow，agent 照样跑（只跑提示词）', async () => {
  const { deps, seen } = harness({ visible: [] });
  const result = await runAgent(deps, { ...base, allow: ['read', 'glob'] });
  assert.equal(result.ok, true);
  assert.deepEqual(seen.restrict, [{ allow: [] }]);
});

test('restrict 仍因未知名抛错：降级成空名单，不把整段弄挂', async () => {
  const { deps, seen } = harness({ restrictError: new Error('tools.restrict() names unknown global tool "foo"') });
  const result = await runAgent(deps, base);
  assert.equal(result.ok, true, 'restrict 抛错只降级，不该判整段失败');
  assert.deepEqual(seen.restrict, [{ allow: ['read', 'memory_recall'] }, { allow: [] }], '先试原名单，被拒后退空名单');
  assert.ok(seen.logs.some((line) => line.includes('restrict 被拒')), `要记一条降级日志，实际：${seen.logs.join(' | ')}`);
});

test('selectAllow：条件注册的工具（when）也算存在——get 说得清，executable 说不清', () => {
  // 复刻宿主：web_search 带 when 条件，executable() 不带 toolSet 时返回 undefined
  const tools = {
    get: (name) => (['read', 'web_search'].includes(name) ? { name } : undefined),
    executable: (name) => (name === 'read' ? { name } : undefined),
  };
  assert.deepEqual(selectAllow(tools, { id: 'child' }, ['read', 'web_search', 'nope']), {
    allow: ['read', 'web_search'],
    unknown: ['nope'],
  });
  // 老宿主没有 get：不许把名字全当不存在
  assert.deepEqual(selectAllow({ restrict: () => {} }, { id: 'child' }, ['read', 'nope']), {
    allow: ['read', 'nope'],
    unknown: [],
  });
  // get 抛错按可见处理，交给 restrict 判
  assert.deepEqual(selectAllow({ get: () => { throw new Error('scope 认不出'); } }, undefined, ['read']), {
    allow: ['read'],
    unknown: [],
  });
});


test('默认不限上限：UNLIMITED_MAX_TOKENS = 0，routeOptions 里根本不出现 maxTokens 键', () => {
  assert.equal(UNLIMITED_MAX_TOKENS, 0, '0 是「不限」的约定值，不是合法的 maxTokens');
  const options = routeOptions({ provider: 'example-provider', model: 'example-model', maxTokens: UNLIMITED_MAX_TOKENS });
  assert.deepEqual(options, { provider: 'example-provider', model: 'example-model' }, '不设上限就不许把 maxTokens 写进 agentOptions');
  assert.equal('maxTokens' in options, false, '限：这个键必须一个都没有');
});

test('显式配 2000：原样透传，不改写', () => {
  assert.deepEqual(routeOptions({ provider: 'example-provider', model: 'example-model', maxTokens: 2000 }), {
    provider: 'example-provider',
    model: 'example-model',
    maxTokens: 2000,
  });
  // 字符串也要按数字透传（配置从 yml 读进来可能是字符串）
  assert.equal(routeOptions({ provider: 'example-provider', model: 'example-model', maxTokens: '2000' }).maxTokens, 2000);
});

test('reasoningEffort 配了 low 就原样透传，落在 agentOptions 上', () => {
  assert.deepEqual(routeOptions({ provider: 'example-provider', model: 'example-model', reasoningEffort: 'low' }), {
    provider: 'example-provider',
    model: 'example-model',
    reasoningEffort: 'low',
  });
  assert.deepEqual(REASONING_EFFORTS, ['low', 'high', 'max'], '宿主 profile 只认这三档');
  // 三档都认，大小写和空格顺手归一
  for (const effort of ['low', 'high', 'max']) {
    assert.equal(routeOptions({ provider: 'example-provider', model: 'example-model', reasoningEffort: effort }).reasoningEffort, effort);
  }
  assert.equal(routeOptions({ provider: 'example-provider', model: 'example-model', reasoningEffort: ' HIGH ' }).reasoningEffort, 'high');
});

test('reasoningEffort 不填：agentOptions 里一个 effort 键都没有，走服务端默认', () => {
  const options = routeOptions({ provider: 'example-provider', model: 'example-model' });
  assert.deepEqual(options, { provider: 'example-provider', model: 'example-model' });
  assert.equal('reasoningEffort' in options, false);
  // 空串、null 也当没填
  assert.equal('reasoningEffort' in routeOptions({ provider: 'example-provider', model: 'example-model', reasoningEffort: '' }), false);
  assert.equal('reasoningEffort' in routeOptions({ provider: 'example-provider', model: 'example-model', reasoningEffort: null }), false);
});

test('reasoningEffort 非法值（medium）：忽略，不往请求里塞宿主 schema 不挡的脏值', () => {
  assert.equal(normalizeReasoningEffort('medium'), '');
  const options = routeOptions({ provider: 'example-provider', model: 'example-model', reasoningEffort: 'medium' });
  assert.deepEqual(options, { provider: 'example-provider', model: 'example-model' });
  assert.equal('reasoningEffort' in options, false);
});

test('预算被推理吃光：报错说清是截断，不再只留「没等到 assistant 文本」', async () => {
  const { deps, seen } = harness({ agent: fakeAgent({ text: '', finish: 'max-tokens' }) });
  const result = await runAgent(deps, { ...base, kind: 'proposer', agentOptions: { provider: 'example-provider', model: 'example-model' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /输出预算/, `实际：${result.error}`);
  assert.match(result.error, /max_tokens/, '要提示去查服务端默认 max_tokens');
  assert.match(result.error, /proposer\.maxTokens/, '要说清该调大哪一段的上限');
  assert.equal(seen.disposed, 1);
});

test('空正文但原因不是截断：报错带 finish 原因，也不糊', async () => {
  const { deps } = harness({ agent: fakeAgent({ text: '', finish: 'stop' }) });
  const result = await runAgent(deps, { ...base, kind: 'judge' });
  assert.equal(result.ok, false);
  assert.match(result.error, /assistant 文本/, `实际：${result.error}`);
  assert.match(result.error, /finish=stop/, '要知道是 stop 而不是截断');
});

test('一步都没跑起来：finish=error，报错带出宿主原话，不再只写「未知」', async () => {
  const { deps } = harness({
    agent: fakeAgent({ text: '', turnEndError: 'agent "x" has no provider/model: set AgentOptions.provider and AgentOptions.model' }),
  });
  const result = await runAgent(deps, { ...base, kind: 'arbiter' });
  assert.equal(result.ok, false);
  assert.match(result.error, /finish=error/, `实际：${result.error}`);
  assert.match(result.error, /has no provider\/model/, '宿主原话要带进日志，别让它退化成「未知」');
  assert.match(result.error, /正文为空/, '要说清是正文空，不是模型答歪');
});

test('turnEndError：只认 turn/end 的 error，stop 和没有 error 都给空串', () => {
  assert.equal(turnEndError([]), '');
  assert.equal(turnEndError([{ type: 'turn/end', data: { reason: { kind: 'stop' } } }]), '');
  assert.equal(
    turnEndError([
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '先错这个' } } } },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '后错这个' } } } },
    ]),
    '后错这个',
    '取最后一次',
  );
});

test('finishKind：流式 finish 优先，没流式才退回 turn/end 的原因', () => {
  assert.equal(
    finishKind([
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '缺 provider/model' } } } },
    ]),
    'error',
    '只有 turn/end 也要认',
  );
  assert.equal(
    finishKind([
      { type: 'turn/end', data: { reason: { kind: 'stop' } } },
      { type: 'assistant/message', data: { stream: [{ type: 'finish', reason: { kind: 'max-tokens' } }] } },
    ]),
    'max-tokens',
    '截断原因不能被 turn/end 的 stop 盖掉',
  );
});

test('emptyReplyError：error 这一路带 detail，其他 finish 照旧', () => {
  assert.match(emptyReplyError('error', 'arbiter', 'has no provider/model'), /has no provider\/model/);
  assert.match(emptyReplyError('error', 'arbiter'), /f?inish=error/, '没 detail 也别写「未知」');
  assert.equal(emptyReplyError('max-tokens', 'judge').includes('max_tokens'), true);
  assert.match(emptyReplyError('', 'judge'), /finish=未知/);
});

test('finishKind：取最后一次 finish 的原因，没有就空串', () => {
  assert.equal(finishKind([]), '');
  assert.equal(finishKind([{ type: 'assistant/message', data: { message: { content: [] } } }]), '');
  assert.equal(
    finishKind([
      { type: 'assistant/attempt', data: { stream: [{ type: 'finish', reason: { kind: 'error' } }] } },
      { type: 'assistant/message', data: { stream: [{ type: 'finish', reason: { kind: 'max-tokens' } }] } },
    ]),
    'max-tokens',
    '后面的 finish 覆盖前面的',
  );
});

test('assistantTurns：数模型往返了几轮，跑完的返回里也带这个数', () => {
  assert.equal(assistantTurns([]), 0);
  assert.equal(
    assistantTurns([
      { type: 'assistant/attempt', data: {} },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先看一眼' }] } } },
      { type: 'tool/result', data: {} },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '跑完了' }] } } },
    ]),
    2,
    '每轮收一条 assistant/message：两轮 = 中间翻过一次工具',
  );
});

test('openAgentSession 建会话同样不带 origin：helper 不走 delegated 分支', async () => {
  const { deps, seen } = harness();
  const opened = await openAgentSession(deps, {
    kind: 'stage2',
    allow: ['read'],
    timeoutMs: 200,
    agentPreset: 'dsh-ego-proposer',
    agentOptions: { provider: 'example-provider', model: 'example-model', maxTokens: 800 },
  });

  assert.equal(opened.ok, true, opened.ok ? '' : opened.error);
  assert.equal('origin' in seen.create[0].meta, false, 'stage2 也不能带 origin，否则 dsh-subagent 判成 delegated 抛 agent has no active runtime owner');
  assert.equal(seen.create[0].meta.agentPreset, 'dsh-ego-proposer', 'agentPreset 要保留');
  assert.deepEqual(seen.mounts.map((mount) => mount.id), ['dsh-ego-proposer'], '可续接 helper 也要挂对应档');

  await opened.dispose();
  assert.equal(seen.disposed, 1, 'dispose 必须调用一次');
});

test('mount 失败不挡建 helper：warn 一行，按无档继续 restrict 并跑完', async () => {
  const { deps, seen, agent } = harness({ mountError: new Error('unknown agent preset: dsh-ego') });
  const result = await runAgent(deps, base);

  assert.equal(result.ok, true, '档不存在也不能让 helper 建不出来');
  assert.equal(result.text, '{"ok":true}');
  assert.equal(seen.mounts.length, 1, '仍然尝试过一次 mount');
  assert.deepEqual(seen.restrict, [{ allow: ['read', 'memory_recall'] }], '挂档失败仍按 ego 自己的 allow 收紧');
  assert.equal(agent.followups.length, 1, '照常把提示词塞进去');
  assert.ok(
    seen.logs.some((line) => line.includes('挂档 dsh-ego 失败') && line.includes('按无档继续')),
    `要 warn 一行，实际：${seen.logs.join(' | ')}`,
  );
});

test('helper 的 setup 挂了 read 守卫：凭据类路径被拒，普通文件照旧', async () => {
  const { deps, seen } = harness();
  const result = await runAgent(deps, base);
  assert.equal(result.ok, true);
  assert.equal(seen.guards.length, 1, 'runAgent 的 setup 里要挂一道 guard');

  const guard = seen.guards[0];
  assert.match(
    guard({ name: 'read', arguments: { file_path: '~/.dsh/.env' } }),
    /凭据类路径/,
    '读 .env 必须被拦',
  );
  assert.equal(guard({ name: 'read', arguments: { file_path: '/home/julia/fatfish/plugins/dsh-ego/lib/gate.js' } }), undefined);
  assert.equal(guard({ name: 'memory_recall', arguments: { query: 'x' } }), undefined, '别的工具不经过这道守卫');

  const opened = await openAgentSession(deps, {
    kind: 'stage2',
    allow: ['read'],
    timeoutMs: 200,
    agentPreset: 'dsh-ego-proposer',
  });
  assert.equal(opened.ok, true, opened.ok ? '' : opened.error);
  assert.equal(seen.guards.length, 2, 'openAgentSession 的 setup 里也要挂一道');
  await opened.dispose();
});
