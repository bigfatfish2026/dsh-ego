/**
 * 打回重写：judge=rewrite / GA12(files>3) → 同一个 stage2 会话续一版 → 再 gate → 再裁决。
 *
 * 盯五件事：
 *   1. judge 判一次 rewrite 后判 do，能照常开出票；
 *   2. GA12 的 files 超限不进终审，直接重写；第二版 files 收到 3 条以内就进 judge；
 *   3. 连判 rewrite 到次数上限落成 ask，且绝不开票；
 *   4. maxRewrite 越界夹到 1/5，配置写错不拒加载；
 *   5. 重写是对同一个 agent 做 followup，不是新开一个 stage2 会话；
 *   6. 用满 maxRewrite 后按最后一次来源落回原处置：judge / 原本降级的关 → ask，
 *      原本判拒的关（GA1/GA2/GA3/GA6/GA10/GA15/GA16/GA17）→ silent，不开票也不喊人。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgentSession } from '../lib/agent-run.js';
import { REWRITE_CODES, REWRITE_GATE_ACTIONS, parseDecisionReport } from '../lib/gate.js';
import { buildJudgePrompt } from '../lib/judge.js';
import { buildStage2RewritePrompt, clampMaxRewrite } from '../lib/proposer.js';
import { exhaustedDecision, rewriteSource, runRewriteLoop } from '../lib/rewrite.js';
import { routeDecision } from '../lib/route.js';

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const plan = (over = {}) => ({
  pick: 'C01',
  step1: { read: 'lib/gate.js:36', verdict: 'continue', abortIf: '没有重复分支就 abort' },
  step2: { change: '删掉 lib/gate.js 里重复的分支', files: ['lib/gate.js'], estLines: 0, undo: 'git checkout -- lib/gate.js' },
  idea: 'lib/gate.js 里有 36 行重复分支，可以删掉',
  why: '上个提交复制粘贴留下的',
  object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:36' },
  evidence: [{ claim: '重复分支在第 36 行', source: 'read', value: '36', at: '2026-11-10T05:28:00Z' }],
  plan: { steps: ['P1×files'], files: ['lib/gate.js'], estLines: 0 },
  intent: {
    impact: { paths: ['lib/gate.js'], services: [], remotes: [] },
    reversibility: 'auto',
    dryRun: { ok: true, detail: 'read lib/gate.js' },
    undo: { kind: '', ref: '', howto: 'git checkout -- lib/gate.js' },
  },
  ...over,
});

const candidate = {
  id: 'C01',
  read: { primitive: 'inspect', objectKind: 'files' },
  action: { primitive: 'edit-file', objectKind: 'files' },
  material: '翻仓库找跑不过的测试',
  motivation: 'hygiene',
  defaults: { impact: 'local-write', reversibility: 'auto' },
};

const okVerdict = () => ({ ok: true, allowDo: true, reject: [], downgrade: [], notes: [], unsupported: [], hits: [] });
const ga12Verdict = (code = 'files', why = 'plan.files 有 4 个文件，超过 3 个，先问一句') => ({
  ...okVerdict(),
  allowDo: false,
  downgrade: [{ ga: 'GA12', code, originalAction: 'ask', why }],
  hits: ['GA12'],
});
/** 原本判拒、现在可重写的关（GA15 / GA16 / GA6 …）：用满次数落 silent */
const hardVerdict = (ga, why) => ({
  ...okVerdict(),
  allowDo: false,
  downgrade: [{ ga, code: ga, originalAction: 'silent', why }],
  hits: [ga],
});
/** 原本就是降级的关（GA7）：用满次数落 ask */
const softVerdict = (ga, why) => ({
  ...okVerdict(),
  allowDo: false,
  downgrade: [{ ga, code: ga, originalAction: 'ask', why }],
  hits: [ga],
});
const doDecision = () => ({
  action: 'do',
  text: '',
  ticket: {
    goal: '删掉 lib/gate.js 里 36 行重复分支',
    brief: '删重复分支',
    intent: { impact: { paths: ['lib/gate.js'], services: [], remotes: [] }, reversibility: 'auto', dryRun: { ok: true, detail: 'read' }, undo: { kind: '', ref: '', howto: 'git checkout -- lib/gate.js' } },
  },
  reason: '改动小且能撤回',
});
const rewriteDecision = (reason = '步骤太含糊，改清楚') => ({ action: 'rewrite', text: '', ticket: null, reason });

function loopHarness({ plans, verdicts, decisions, maxRewrite = 3 }) {
  const seen = { prompts: [], judgeCalls: 0, picks: 0, empties: 0, logs: [] };
  const planList = [...plans];
  const verdictList = [...verdicts];
  const decisionList = [...decisions];
  return {
    seen,
    options: {
      maxRewrite,
      firstPrompt: '第一版提示词',
      rewritePrompt: (feedback) => buildStage2RewritePrompt(feedback),
      stage2: async (prompt) => {
        seen.prompts.push(prompt);
        return { ok: true, plan: planList.shift() ?? plan() };
      },
      checkPlan: async () => verdictList.shift() ?? okVerdict(),
      judge: async () => {
        seen.judgeCalls += 1;
        return { ok: true, decision: decisionList.shift() ?? doDecision() };
      },
      buildProposal: (p, verdict) => ({
        ...p,
        gateDowngrade: verdict.downgrade.map((one) => `[${one.ga}] ${one.why}`),
      }),
      onPick: () => { seen.picks += 1; },
      onEmpty: () => { seen.empties += 1; },
      log: (line) => seen.logs.push(line),
    },
  };
}

/* ── 1. judge 一次 rewrite → do：能开出票 ─────────────────────────── */

test('judge 判一次 rewrite 后判 do：第二版接着改，终判 do 能开出票', async () => {
  const h = loopHarness({
    plans: [plan(), plan({ idea: 'lib/gate.js 第 36 行那 36 行重复分支删掉，只动 1 个文件', plan: { steps: ['P1×files'], files: ['lib/gate.js'], estLines: 0 } })],
    verdicts: [okVerdict(), okVerdict()],
    decisions: [rewriteDecision('步骤写得含糊，改成删第 36 行那一段'), doDecision()],
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'decided');
  assert.equal(outcome.decision.action, 'do');
  assert.equal(outcome.rewrites, 1);
  assert.equal(h.seen.judgeCalls, 2, '第一版 rewrite、第二版 do，终审叫两次');
  assert.equal(h.seen.prompts.length, 2, 'stage2 也只跑两版');
  assert.match(h.seen.prompts[1], /步骤写得含糊，改成删第 36 行那一段/, '原因原文要进重写消息');
  assert.match(h.seen.prompts[1], /最多 3 条/, '硬上限要写进重写消息');
  assert.ok(h.seen.logs.some((line) => line.startsWith('stage2_rewrite:1｜by:judge｜left:2｜why:步骤写得含糊')), '每次重写记一行，带来源和剩余次数');
  assert.ok(h.seen.logs.includes('stage2_rewrite_done:共1次｜终判:do'));

  const opened = [];
  const said = [];
  const routed = await routeDecision(outcome.decision, {
    ask: async (text) => { said.push(text); return { ok: true }; },
    openTicket: async (ticket) => { opened.push(ticket); return { ok: true, ticket: 't-abc-xyz' }; },
  });
  assert.equal(routed.action, 'do');
  assert.equal(opened.length, 1, '终判 do 要真的走到开票');
  assert.equal(said.length, 0);
});

/* ── 2. GA12(files>3)：不进 judge，直接重写 ───────────────────────── */

test('GA12 的 files 超限不进 judge；第二版 files 收到 3 条以内才进 judge', async () => {
  const four = plan({ plan: { steps: ['P1×files'], files: ['a.js', 'b.js', 'c.js', 'd.js'], estLines: 0 } });
  const three = plan({ plan: { steps: ['P1×files'], files: ['a.js', 'b.js', 'c.js'], estLines: 0 } });
  const h = loopHarness({
    plans: [four, three],
    verdicts: [ga12Verdict(), okVerdict()],
    decisions: [doDecision()],
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'decided');
  assert.equal(h.seen.judgeCalls, 1, '第一版 GA12 直接打回，只有第二版进终审');
  assert.equal(h.seen.prompts.length, 2);
  assert.match(h.seen.prompts[1], /plan\.files 有 4 个文件，超过 3 个/, 'GA12 原因原文要进重写消息');
  assert.match(h.seen.prompts[1], /a\.js、b\.js、c\.js、d\.js/, '上一版的 files 要列出来');
  assert.ok(h.seen.logs.some((line) => line.startsWith('stage2_rewrite:1｜by:GA12｜left:2｜why:plan.files 有 4 个文件')));
});

/* ── 3. 连判 rewrite 到上限：落成 ask，绝不开票 ───────────────────── */

test('连判 3 次 rewrite 落成 ask：跑满 maxRewrite 就收手，不开票', async () => {
  const h = loopHarness({
    plans: [plan(), plan(), plan(), plan()],
    verdicts: [okVerdict(), okVerdict(), okVerdict(), okVerdict()],
    decisions: [rewriteDecision(), rewriteDecision(), rewriteDecision(), rewriteDecision()],
    maxRewrite: 3,
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'exhausted');
  assert.equal(outcome.decision.action, 'ask');
  assert.match(outcome.decision.text, /改了 3 次还是没改好，要不要开票/);
  assert.equal(outcome.rewrites, 3);
  assert.equal(h.seen.prompts.length, 4, '首发 + 3 次重写，一共 4 版');
  assert.equal(h.seen.judgeCalls, 4);
  assert.ok(h.seen.logs.some((line) => line.startsWith('rewrite_exhausted:共3次')));

  const opened = [];
  const said = [];
  const routed = await routeDecision(outcome.decision, {
    ask: async (text) => { said.push(text); return { ok: true }; },
    openTicket: async (ticket) => { opened.push(ticket); return { ok: true }; },
  });
  assert.equal(routed.action, 'ask');
  assert.equal(opened.length, 0, '用满次数也不许自己开票');
  assert.equal(said.length, 1);
});

/* ── 4. 次数与配置夹值 ────────────────────────────────────────────── */

test('maxRewrite 越界夹到边界并 warn：99→5、0→1', () => {
  const warned = [];
  const warn = (line) => warned.push(line);
  assert.equal(clampMaxRewrite(99, { warn }), 5);
  assert.equal(clampMaxRewrite(0, { warn }), 1);
  assert.equal(clampMaxRewrite(3, { warn }), 3);
  assert.equal(clampMaxRewrite(2.7, { warn }), 2);
  assert.ok(warned.some((line) => line.includes('超过 5')));
  assert.ok(warned.some((line) => line.includes('小于 1')));

  // GA12 三个幅度分支都带 code，都触发重写；没有 code 的普通降级（GA11/GA13）不触发
  assert.equal(rewriteSource({ downgrade: [{ ga: 'GA12', why: '没有 code 的旧形状' }] }), null);
  assert.equal(rewriteSource({ downgrade: [{ ga: 'GA12', code: 'files', why: '4 个文件' }] }).source, 'GA12');
  assert.equal(rewriteSource({ downgrade: [{ ga: 'GA12', code: 'steps', why: '6 步' }] }).code, 'steps');
  assert.equal(rewriteSource({ downgrade: [{ ga: 'GA12', code: 'estLines', why: '60 行' }] }).code, 'estLines');
  assert.equal(rewriteSource({ downgrade: [{ ga: 'GA15', code: 'GA15', originalAction: 'silent', why: '结构不齐' }] }).originalAction, 'silent');
  assert.equal(rewriteSource({ downgrade: [{ ga: 'GA11', why: '峰价' }] }), null);
  assert.equal(exhaustedDecision(3, '还是 rewrite').action, 'ask');
  assert.equal(exhaustedDecision(3, '还是结构不齐', 'silent').action, 'silent');
  assert.equal(exhaustedDecision(3, '还是结构不齐', 'silent').text, '');
});

/* ── 5. 终审与重写消息的契约 ────────────────────────────────────── */

test('终审提示词和解析都认 rewrite，reason 空着不收', () => {
  const prompt = buildJudgePrompt({ idea: '把 3 个文件改一下', why: '测试' });
  assert.match(prompt, /四个选项/);
  assert.match(prompt, /rewrite/);
  assert.match(prompt, /reason 必须写清「要改什么」/);
  assert.match(prompt, /silent\|ask\|do\|rewrite/);

  const accepted = parseDecisionReport('{"action":"rewrite","reason":"plan.files 4 个，压到 3 个以内"}');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.decision.action, 'rewrite');
  assert.equal(accepted.decision.ticket, null);
  assert.match(accepted.decision.reason, /压到 3 个以内/);

  const noReason = parseDecisionReport('{"action":"rewrite","reason":"  "}');
  assert.equal(noReason.ok, false);
  assert.ok(noReason.problems.some((line) => line.includes('reason 是空的')));
});

test('重写消息是固定句式：原因 + 上一版 idea/why/files + 3 条硬上限 + 别推倒重来', () => {
  const message = buildStage2RewritePrompt({
    source: 'GA12',
    reason: 'plan.files 有 4 个文件，超过 3 个',
    idea: '上一版点子',
    why: '上一版理由',
    files: ['a.js', 'b.js', 'c.js', 'd.js'],
  });
  assert.match(message, /GA12/);
  assert.match(message, /plan\.files 有 4 个文件/);
  assert.match(message, /上一版点子/);
  assert.match(message, /上一版理由/);
  assert.match(message, /最多 3 条/);
  assert.match(message, /在原方案上改，别推倒重来/);
  assert.match(message, /plan\.files（4 条）/);
});

/* ── 6. 续接：同一个 agent 做 followup，不是新开会话 ───────────────── */

test('openAgentSession：两版 plan 都 followup 到同一个 agent，只 create 一次', async () => {
  let disposed = 0;
  let created = 0;
  const agent = {
    status: 'idle',
    session: { seq: 0, snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"ok":true}' }] }, stream: [] } }] },
    followups: [],
    followup(message) {
      agent.followups.push(message);
      agent.session.seq += 1;
      agent.status = 'running';
    },
    whenIdle() {
      agent.status = 'idle';
      return Promise.resolve();
    },
  };
  const deps = {
    log: () => {},
    uuid: () => 'fixed-uuid',
    now: () => 1000,
    async create(options) {
      created += 1;
      assert.equal(options.sessionId, 'fixed-uuid');
      const setupResult = options.setup({ tools: { get: () => ({ name: 'read' }), restrict: () => {} } }, { id: 'child' });
      setupResult?.commit();
      return {
        agent,
        async dispose() { disposed += 1; },
      };
    },
  };
  const session = await openAgentSession(deps, { kind: 'stage2', allow: ['read'], timeoutMs: 200 });
  assert.equal(session.ok, true);
  const first = await session.ask('第一版提示词');
  const second = await session.ask('上一版被打回了，接着改');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(created, 1, '重写不许新开 stage2 会话');
  assert.equal(agent.followups.length, 2, '两版都 followup 到同一个 agent');
  assert.match(agent.followups[1].content[0].text, /接着改/);
  assert.equal(disposed, 0, '没 dispose 之前会话还在');
  await session.dispose();
  assert.equal(disposed, 1);
});

/* ── 7. GA12 的 steps / estLines 分支也走 rewrite ─────────────────── */

test('GA12 的 steps 超 5 和 estLines 超 40 也能触发 rewrite，不只 files', async () => {
  const cases = [
    ['steps', 'plan.steps 有 6 步，超过 5 步，先问一句'],
    ['estLines', 'estLines 估了 60 行，超过单文件 40 行，先问一句'],
  ];
  for (const [code, why] of cases) {
    const h = loopHarness({
      plans: [plan(), plan()],
      verdicts: [ga12Verdict(code, why), okVerdict()],
      decisions: [doDecision()],
    });
    const outcome = await runRewriteLoop(h.options);
    assert.equal(outcome.kind, 'decided', `${code} 超限应该打回重写，不该进 exhausted`);
    assert.equal(h.seen.judgeCalls, 1, `${code} 超限直接打回，第一版不进终审`);
    assert.equal(h.seen.prompts.length, 2, `${code} 只重写一版就过`);
    assert.ok(h.seen.prompts[1].includes(why), `${code} 的原因原文要进重写消息`);
    assert.ok(h.seen.logs.some((line) => line.startsWith('stage2_rewrite:1｜by:GA12｜left:2｜why:')), `${code} 日志带来源`);
  }
});

/* ── 8. 用满次数落回「原本的处置」 ────────────────────────────────── */

test('原本硬拒的 GA15 重写三次仍不合格 → 落 silent，不开票也不喊人', async () => {
  const h = loopHarness({
    plans: [plan(), plan(), plan(), plan()],
    verdicts: [
      hardVerdict('GA15', '两步式结构不齐：step1 三栏没写全'),
      hardVerdict('GA15', '两步式结构不齐：step1 三栏没写全'),
      hardVerdict('GA15', '两步式结构不齐：step1 三栏没写全'),
      hardVerdict('GA15', '两步式结构不齐：step1 三栏没写全'),
    ],
    decisions: [],
    maxRewrite: 3,
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'exhausted');
  assert.equal(outcome.decision.action, 'silent', 'GA15 原本是拒，用满次数落回 silent 而不是 ask');
  assert.equal(outcome.decision.text, '');
  assert.match(outcome.decision.reason, /rewrite_exhausted：两步式结构不齐/);
  assert.equal(outcome.rewrites, 3);
  assert.equal(h.seen.prompts.length, 4, '首发 + 3 次重写');
  assert.equal(h.seen.judgeCalls, 0, 'gate 降级打回不叫终审');
  assert.ok(h.seen.logs.some((line) => line.startsWith('rewrite_exhausted:共3次｜原因:GA15｜落回:silent')));

  const opened = [];
  const said = [];
  const routed = await routeDecision(outcome.decision, {
    ask: async (text) => { said.push(text); return { ok: true }; },
    openTicket: async (ticket) => { opened.push(ticket); return { ok: true }; },
  });
  assert.equal(routed.action, 'silent');
  assert.equal(routed.called, false);
  assert.equal(opened.length, 0, '原本判拒的关用满次数也不许开票');
  assert.equal(said.length, 0, '也不许问用户');
});

test('原本硬拒的 GA16 重写三次仍不合格 → 落 silent', async () => {
  const why = 'plan.steps 的第一步是动作原语（edit-file）：读的那一步要排在动前面';
  const h = loopHarness({
    plans: [plan(), plan(), plan(), plan()],
    verdicts: [hardVerdict('GA16', why), hardVerdict('GA16', why), hardVerdict('GA16', why), hardVerdict('GA16', why)],
    decisions: [],
    maxRewrite: 2,
  });
  const outcome = await runRewriteLoop(h.options);
  assert.equal(outcome.kind, 'exhausted');
  assert.equal(outcome.decision.action, 'silent');
  assert.equal(outcome.rewrites, 2);
  assert.equal(h.seen.prompts.length, 3);
});

test('原本降级的 GA7 重写三次仍不合格 → 落 ask 问用户', async () => {
  const h = loopHarness({
    plans: [plan(), plan(), plan(), plan()],
    verdicts: [
      softVerdict('GA7', 'undo.howto 没命中 edit-file 的撤回模板'),
      softVerdict('GA7', 'undo.howto 没命中 edit-file 的撤回模板'),
      softVerdict('GA7', 'undo.howto 没命中 edit-file 的撤回模板'),
      softVerdict('GA7', 'undo.howto 没命中 edit-file 的撤回模板'),
    ],
    decisions: [],
    maxRewrite: 3,
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'exhausted');
  assert.equal(outcome.decision.action, 'ask', 'GA7 原本就是降级 ask，用满次数还是 ask');
  assert.match(outcome.decision.text, /改了 3 次还是没改好，要不要开票/);
  assert.match(outcome.decision.reason, /rewrite_exhausted：undo\.howto/);
  assert.equal(h.seen.judgeCalls, 0);

  const opened = [];
  const said = [];
  const routed = await routeDecision(outcome.decision, {
    ask: async (text) => { said.push(text); return { ok: true }; },
    openTicket: async (ticket) => { opened.push(ticket); return { ok: true }; },
  });
  assert.equal(routed.action, 'ask');
  assert.equal(said.length, 1);
  assert.equal(opened.length, 0);
});

/* ── 9. 来源表本身 ─────────────────────────────────────────────────── */

test('可重写来源表：十一关 + GA12 三分支，原处置只有 silent / ask', () => {
  assert.deepEqual(Object.keys(REWRITE_GATE_ACTIONS).sort(), ['GA1', 'GA10', 'GA12', 'GA15', 'GA16', 'GA17', 'GA2', 'GA3', 'GA6', 'GA7', 'GA8']);
  for (const [ga, action] of Object.entries(REWRITE_GATE_ACTIONS)) {
    assert.ok(action === 'silent' || action === 'ask', `${ga} 的原处置只能是 silent / ask`);
    assert.ok(REWRITE_CODES.has(ga), `${ga} 要在 REWRITE_CODES 里`);
  }
  for (const code of ['files', 'steps', 'estLines']) assert.ok(REWRITE_CODES.has(code), `GA12 的 ${code} 分支要认`);
  // 不许重写、保持拒的四关；判不了的两关都不在表里
  for (const ga of ['GA4', 'GA5', 'GA9', 'GA11', 'GA13', 'GA14']) {
    assert.equal(REWRITE_GATE_ACTIONS[ga], undefined, `${ga} 不接 rewrite`);
    assert.equal(REWRITE_CODES.has(ga), false, `${ga} 不该被 rewrite 循环认`);
  }
});

/* ── 10. abort 与 rewrite 的顺序 ───────────────── */

/*
 * 2026-11-11 12:15 那拍：gate 降级 GA6/GA7/GA10（都在 REWRITE_GATE_ACTIONS 里，本该打回重写），
 * stage2 自己写了 step1.verdict=abort，旧顺序里 abort 短路排在 rewriteSource 前面，
 * 一拍直接 silent 收工，rewrite 一次没跑到。
 */
const abortPlan = (over = {}) => plan({
  step1: { read: 'lib/gate.js:36', verdict: 'abort', abortIf: '没有重复分支就 abort' },
  step2: null,
  object: null,
  evidence: [],
  plan: { steps: [], files: [], estLines: 0 },
  intent: null,
  ...over,
});

test('gate 有 GA6/GA7/GA10 降级 + stage2 verdict=abort：先进 rewrite，不直接 silent', async () => {
  for (const ga of ['GA6', 'GA7', 'GA10']) {
    const why = `${ga} 挡着：这一版方案不合格`;
    const h = loopHarness({
      // 第一版 abort + 降级；重写后的第二版才是正常方案
      plans: [abortPlan(), plan()],
      verdicts: [ga === 'GA7' ? softVerdict(ga, why) : hardVerdict(ga, why), okVerdict()],
      decisions: [doDecision()],
      maxRewrite: 1,
    });
    const outcome = await runRewriteLoop(h.options);

    assert.equal(outcome.kind, 'decided', `${ga}：重写后判 do，不该出现 ${outcome.kind}`);
    assert.equal(h.seen.prompts.length, 2, `${ga}：abort 的那版必须先被打回重写一次`);
    assert.match(h.seen.prompts[1], new RegExp(ga), `${ga}：重写提示词要带来源关卡`);
    assert.equal(h.seen.judgeCalls, 1, `${ga}：第一版 abort+降级不该进终审，第二版才进`);
    assert.equal(outcome.decision.action, 'do');
    assert.equal(outcome.rewrites, 1);
    assert.ok(
      h.seen.logs.some((line) => line.startsWith(`stage2_abort_override:gate ${ga}`)),
      `${ga}：要留一行「先重写不 abort」，实际：${h.seen.logs.join('｜')}`,
    );
    assert.equal(h.seen.logs.some((line) => line.includes('stage2_abort:')), false, `${ga}：不许走 abort 收工`);
  }
});

test('gate 无降级 + verdict=abort：照旧直接 silent，不重写、不叫终审', async () => {
  const h = loopHarness({
    plans: [abortPlan(), plan()],
    verdicts: [okVerdict(), okVerdict()],
    decisions: [doDecision()],
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'abort');
  assert.equal(outcome.plan.step1.verdict, 'abort');
  assert.equal(h.seen.prompts.length, 1, '纯 abort 不许额外跑一次 stage2');
  assert.equal(h.seen.judgeCalls, 0, '纯 abort 不许叫终审');
  assert.equal(h.seen.empties, 0, 'abort 不是空拍');
  assert.equal(h.seen.picks, 1, 'pick 非空照样在 gate 之前记账');
});

test('重写完那一版自己 abort（gate 已无可重写项）：重写一次后按 abort 收工', async () => {
  const h = loopHarness({
    plans: [plan(), abortPlan()],
    verdicts: [softVerdict('GA10', 'GA10：改动面超过上限'), okVerdict()],
    decisions: [],
    maxRewrite: 3,
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'abort');
  assert.equal(outcome.rewrites, 1, '第一版重写过一次，第二版 abort 就不再重写');
  assert.equal(h.seen.prompts.length, 2);
  assert.equal(h.seen.judgeCalls, 0);
});

test('abort + 降级用满次数：落回仍按 REWRITE_GATE_ACTIONS 表走，GA7 → ask', async () => {
  const why = 'GA7：undo.howto 没命中撤回模板';
  const h = loopHarness({
    plans: [abortPlan(), abortPlan(), abortPlan()],
    verdicts: [softVerdict('GA7', why), softVerdict('GA7', why), softVerdict('GA7', why)],
    decisions: [],
    maxRewrite: 2,
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'exhausted');
  assert.equal(outcome.rewrites, 2);
  assert.equal(outcome.decision.action, 'ask', 'GA7 原本就是降级 ask，用满次数还是 ask');
  assert.match(outcome.decision.reason, /rewrite_exhausted：GA7/);
  assert.equal(h.seen.prompts.length, 3);
  assert.equal(h.seen.judgeCalls, 0);
});
