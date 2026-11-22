/**
 * E2：judge 第二意见（gemini-decision 桥）。
 *
 * 盯三件事：
 *   1. 客户端六项校验：HTTP 2xx / answers 形状 / 候选 / prob 键集合 / Σp / confidence 一致；
 *      任何一项不过都返回 ok:false，绝不把半个答案交给调用方；
 *   2. 开关关着时 judge 一次请求都不发，结论与接入前逐字一致（对拍就是「action 还是 do」）；
 *   3. 开着时只往保守方向改：桥判 ask 且置信度够 → do 降 ask；桥挂掉 / 超时 / 坏 JSON /
 *      回 do → 原结论不动。
 *
 * 所有桥都是本机假的 http 服务，一个字节都不往外发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAdjudicator } from '../lib/engines/adjudicator.js';
import { createGate } from '../lib/gate.js';
import { createGeminiDecision, geminiDecisionCfgOf } from '../lib/gemini-decision.js';

/* ── 假桥 ─────────────────────────────────────────────────────────── */

/**
 * 起一个本机假桥。handler(body, res) 自己决定回什么；不给 handler 就永不响应（测超时）。
 * @returns {Promise<{baseUrl: string, requests: object[], close: () => Promise<void>}>}
 */
async function startBridge(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = raw; }
      requests.push(body);
      if (handler) handler(body, res);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function answerOf(choice, confidence, probabilities) {
  const body = { answers: { q1: { type: 'choice', choice, confidence, probabilities } } };
  return body;
}

/** 回一段 JSON 的桥 */
function replyWith(body, status = 200) {
  return (reqBody, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

const CRITERIA = { do: '直接执行', ask: '先问一句' };

/* ── 客户端：六项校验 ─────────────────────────────────────────────── */

test('客户端：正常答案原样回，请求里带 model / state / choice 题', async () => {
  const bridge = await startBridge(replyWith(answerOf('ask', 0.97, { do: 0.03, ask: 0.97 })));
  const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 });
  const result = await client.ask({ state: '一句话事实', instructions: '选一个', criteria: CRITERIA });
  await bridge.close();

  assert.equal(result.ok, true);
  assert.equal(result.choice, 'ask');
  assert.equal(result.confidence, 0.97);
  assert.deepEqual(result.probabilities, { do: 0.03, ask: 0.97 });
  assert.equal(bridge.requests.length, 1);
  const sent = bridge.requests[0];
  assert.equal(sent.model, 'gemini-decision-1');
  assert.equal(sent.state, '一句话事实');
  assert.equal(sent.questions.q1.type, 'choice');
  assert.deepEqual(Object.keys(sent.questions.q1.criteria), ['do', 'ask']);
});

test('客户端：HTTP 400 直接失败，原因带状态码', async () => {
  const bridge = await startBridge(replyWith({ error: 'region' }, 400));
  const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 });
  const result = await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await bridge.close();
  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'http_400' });
});

test('客户端：坏 JSON / 缺 answers 都算失败', async () => {
  const badJson = await startBridge((reqBody, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{not json');
  });
  const client1 = createGeminiDecision({ enabled: true, baseUrl: badJson.baseUrl, timeoutMs: 1000 });
  const r1 = await client1.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await badJson.close();
  assert.equal(r1.reason, 'bad_json');

  const noAnswers = await startBridge(replyWith({ answers: [] }));
  const client2 = createGeminiDecision({ enabled: true, baseUrl: noAnswers.baseUrl, timeoutMs: 1000 });
  const r2 = await client2.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await noAnswers.close();
  assert.equal(r2.reason, 'shape');
});

test('客户端：choice 不在候选里 → choice_not_candidate', async () => {
  const bridge = await startBridge(replyWith(answerOf('keep', 0.9, { do: 0.1, ask: 0.9 })));
  const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 });
  const result = await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await bridge.close();
  assert.equal(result.reason, 'choice_not_candidate');
});

test('客户端：probabilities 键集合必须与 criteria 完全相等', async () => {
  const missing = await startBridge(replyWith(answerOf('do', 0.9, { do: 0.9 })));
  const client1 = createGeminiDecision({ enabled: true, baseUrl: missing.baseUrl, timeoutMs: 1000 });
  const r1 = await client1.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await missing.close();
  assert.equal(r1.reason, 'prob_keys', '少一个键也算坏');

  const extra = await startBridge(replyWith(answerOf('do', 0.8, { do: 0.8, ask: 0.15, maybe: 0.05 })));
  const client2 = createGeminiDecision({ enabled: true, baseUrl: extra.baseUrl, timeoutMs: 1000 });
  const r2 = await client2.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await extra.close();
  assert.equal(r2.reason, 'prob_keys', '多一个键也算坏');
});

test('客户端：Σp 必须落在 1±1e-6，超了算 prob_sum', async () => {
  const bridge = await startBridge(replyWith(answerOf('do', 0.9, { do: 0.9, ask: 0.2 })));
  const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 });
  const result = await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await bridge.close();
  assert.equal(result.reason, 'prob_sum');
});

test('客户端：confidence 与 p[choice] 不一致算 bad_confidence', async () => {
  const bridge = await startBridge(replyWith(answerOf('ask', 0.6, { do: 0.1, ask: 0.9 })));
  const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 });
  const result = await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await bridge.close();
  assert.equal(result.reason, 'bad_confidence');
});

test('客户端：超时 → timeout，不重试（只发一次）', async () => {
  const bridge = await startBridge(null);
  const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 200 });
  const result = await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await bridge.close();
  assert.equal(result.reason, 'timeout');
  assert.equal(bridge.requests.length, 1, '一次调用只许发一次');
});

test('客户端：开关关着不发请求；配置归一 enabled 只认严格 true', async () => {
  const bridge = await startBridge(replyWith(answerOf('ask', 0.99, { do: 0.01, ask: 0.99 })));
  const off = createGeminiDecision({ enabled: 'true', baseUrl: bridge.baseUrl, timeoutMs: 1000 });
  const result = await off.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA });
  await bridge.close();
  assert.equal(result.reason, 'disabled');
  assert.equal(bridge.requests.length, 0);

  const cfg = geminiDecisionCfgOf({ enabled: true, timeoutMs: 10, minConfidence: 9, baseUrl: 'http://a:1/' });
  assert.equal(cfg.timeoutMs, 200, '超时下限 200ms');
  assert.equal(cfg.minConfidence, 1, '置信度夹到 1');
  assert.equal(cfg.baseUrl, 'http://a:1', '尾部斜杠去掉');
  assert.equal(geminiDecisionCfgOf(undefined).enabled, false, '缺配置默认关');
});

/* ── adjudicator：开关 off / on ─────────────────────────────────── */

const PLAN = {
  pick: 'C01',
  step1: { read: 'lib/gate.js:36', verdict: 'continue', abortIf: '没有重复分支就 abort' },
  step2: { change: '删掉 lib/gate.js 里重复的分支', files: ['lib/gate.js'], estLines: 0, undo: 'git checkout -- lib/gate.js' },
  idea: 'lib/gate.js 里有重复分支可以删',
  why: '上个提交复制粘贴留下的',
  object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:36' },
  evidence: [],
  plan: { steps: ['P1×files'], files: ['lib/gate.js'], estLines: 0 },
  intent: null,
};

const DO_JSON = JSON.stringify({
  action: 'do',
  ticket: { goal: '删掉 lib/gate.js 里重复的分支，跑一遍 dsh-ego 的单测确认没退化' },
  reason: '改动小、有 git checkout 能撤回',
});

const ASK_JSON = JSON.stringify({
  action: 'ask',
  text: 'lib/gate.js 里 36 行重复分支删掉就回不来，能撤回的只有今天的 git 记录，昨天那份备份没覆盖到这块，要不要先补 1 份完整备份再动手？',
  reason: '删代码前想确认备份面',
});

function fakeAgentFactory(text) {
  return async () => ({
    agent: {
      status: 'running',
      session: {
        seq: 0,
        snapshotEvents: () => [{
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text }] } },
        }],
      },
      followup() {},
      whenIdle() { return Promise.resolve(); },
    },
    dispose: async () => {},
  });
}

function makeAdjudicator({ judgeText = DO_JSON, geminiDecision } = {}) {
  const lines = [];
  const gate = createGate({ ask: { minChars: 60, maxChars: 160, forbidden: [] } });
  const cfg = {
    judge: {
      enabled: true, provider: '', model: '', maxTokens: 1000, timeoutMs: 2000,
      allow: [], askMinChars: 60, askMaxChars: 160, forbiddenWords: [], intentRequired: false,
    },
    arbiter: { enabled: false },
    vetoEnabled: false,
    geminiDecision: geminiDecision ?? { enabled: false },
  };
  const adjudicator = createAdjudicator({
    cfg,
    state: {},
    log: (line) => lines.push(line),
    gate,
    ctx: { agents: { create: fakeAgentFactory(judgeText) } },
  });
  return { adjudicator, lines };
}

test('adjudicator：开关关着时 judge 结论逐字不变，桥一次都不打', async () => {
  const bridge = await startBridge(replyWith(answerOf('ask', 0.99, { do: 0.01, ask: 0.99 })));
  const { adjudicator, lines } = makeAdjudicator({
    geminiDecision: { enabled: false, baseUrl: bridge.baseUrl, timeoutMs: 1000 },
  });
  const result = await adjudicator.judge(PLAN, Date.now());
  await bridge.close();

  assert.equal(result.ok, true);
  assert.equal(result.decision.action, 'do', '关着就必须还是 do');
  assert.equal(result.decision.text, '');
  assert.equal(bridge.requests.length, 0, '关着不许发请求');
  assert.equal(lines.filter((line) => line.startsWith('gemini:')).length, 0, '关着不许打 gemini: 行');
});

test('adjudicator：桥判 ask 且置信度够 → do 降级成 ask，reason 留痕', async () => {
  const bridge = await startBridge(replyWith(answerOf('ask', 0.95, { do: 0.05, ask: 0.95 })));
  const { adjudicator, lines } = makeAdjudicator({
    geminiDecision: { enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000, minConfidence: 0.9 },
  });
  const result = await adjudicator.judge(PLAN, Date.now());
  await bridge.close();

  assert.equal(result.ok, true);
  assert.equal(result.decision.action, 'ask');
  assert.equal(result.decision.ticket, null);
  assert.equal(result.decision.downgradedFrom, 'do');
  assert.match(result.decision.reason, /降级成 ask/);
  assert.ok(result.decision.text.endsWith('？'), result.decision.text);
  assert.ok([...result.decision.text].length <= 160, 'ask 文案要收口到 160 以内');
  assert.equal(bridge.requests.length, 1);
  assert.deepEqual(Object.keys(bridge.requests[0].questions.q1.criteria), ['do', 'ask']);
  assert.match(bridge.requests[0].state, /终审要做的活/);
  assert.ok(lines.some((line) => line.startsWith('gemini:call site=ego.judge')));
  assert.ok(lines.some((line) => line.startsWith('gemini:use site=ego.judge taken=1')));
});

test('adjudicator：桥回 do → 原结论不动（只记 taken=0）', async () => {
  const bridge = await startBridge(replyWith(answerOf('do', 0.99, { do: 0.99, ask: 0.01 })));
  const { adjudicator, lines } = makeAdjudicator({
    geminiDecision: { enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 },
  });
  const result = await adjudicator.judge(PLAN, Date.now());
  await bridge.close();

  assert.equal(result.decision.action, 'do');
  assert.ok(lines.some((line) => line.includes('taken=0')), lines.join('｜'));
});

test('adjudicator：桥超时 → 原 do 不动，日志记 gemini:fail timeout', async () => {
  const bridge = await startBridge(null);
  const { adjudicator, lines } = makeAdjudicator({
    geminiDecision: { enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 200 },
  });
  const result = await adjudicator.judge(PLAN, Date.now());
  await bridge.close();

  assert.equal(result.decision.action, 'do', '桥挂了不许改结论');
  const failLine = lines.find((line) => line.startsWith('gemini:fail'));
  assert.ok(failLine, lines.join('｜'));
  assert.match(failLine, /kind=network/);
  assert.match(failLine, /reason=timeout/);
});

test('adjudicator：桥回坏 JSON → 原 do 不动，reason=bad_json', async () => {
  const bridge = await startBridge((reqBody, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"answers":oops');
  });
  const { adjudicator, lines } = makeAdjudicator({
    geminiDecision: { enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 },
  });
  const result = await adjudicator.judge(PLAN, Date.now());
  await bridge.close();

  assert.equal(result.decision.action, 'do');
  assert.ok(lines.some((line) => line.includes('reason=bad_json')), lines.join('｜'));
});

test('adjudicator：judge 本来就是 ask → 不调桥（桥开着也不发）', async () => {
  const bridge = await startBridge(replyWith(answerOf('ask', 0.99, { do: 0.01, ask: 0.99 })));
  const { adjudicator } = makeAdjudicator({
    judgeText: ASK_JSON,
    geminiDecision: { enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 },
  });
  const result = await adjudicator.judge(PLAN, Date.now());
  await bridge.close();

  assert.equal(result.decision.action, 'ask');
  assert.equal(bridge.requests.length, 0, '只有 do 才问桥');
});
