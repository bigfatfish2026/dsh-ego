/**
 * 裁决器·arbiter 关（第三关）：gate 判不了的灰色条目，打包给一只轻量 agent 逐条判。
 *
 * 盯七件事：
 *   1. gate 里该送的灰色分支进 unsure、不进 unsupported（源码断言 + 行为断言），
 *      能改代码判死的分支（GA2 缺矩阵 / GA6 缺 defaults / GA15·GA16 平铺候选）不送；
 *   2. 解析：合法 JSON 照收、坏 JSON 返回 null、缺字段的条目跳过、一条不剩也返回 null；
 *   3. 合并：pass 按 unsupported 放行、reject 进 reject、downgrade 进 downgrade，
 *      模型编出来的 / 配不上的判定一律忽略，没被判到的条目按 unsupported 兜底；
 *   4. 失败降级：超时 / 坏 JSON / 抛错 → 条目全按 unsupported，整拍交给终审不是拒掉；
 *   5. maxCases 按 GA 编号截断，截掉多少条进日志；
 *   6. 配置非法值回落默认：maxCases 写 abc / 0 / 999 都不拒加载，maxTokens 越界夹边界；
 *   7. 源码顺序：gate → veto → arbiter → judge，arbiter 只拿 read 权限、只回 JSON。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ARBITER_MAX_CASES_DEFAULT,
  ARBITER_MAX_CASES_MAX,
  ARBITER_MAX_CASES_MIN,
  arbiterCaseLine,
  arbiterFailLine,
  arbiterJudgeLine,
  arbiterRetryLine,
  arbiterSkipLine,
  ARBITER_RETRY_HINT,
  buildArbiterPrompt,
  clampArbiterMaxCases,
  isEmptyReply,
  mergeArbiterVerdicts,
  parseArbiterReply,
  resolveArbiterRoute,
  retryPrompt,
  runArbiter,
  selectArbiterCases,
} from '../lib/arbiter.js';
import { ARBITER_MAX_TOKENS_DEFAULT, clampArbiterMaxTokens } from '../lib/budget.js';
import { checkStage2Plan } from '../lib/gate.js';
import { runRewriteLoop } from '../lib/rewrite.js';

const gateSrc = fs.readFileSync(new URL('../lib/gate.js', import.meta.url), 'utf8');
const indexSrc = [
  fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8'),
].join('\n');
const rewriteSrc = fs.readFileSync(new URL('../lib/rewrite.js', import.meta.url), 'utf8');
const arbiterSrc = fs.readFileSync(new URL('../lib/arbiter.js', import.meta.url), 'utf8');
const patchSrc = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const candidate = (over = {}) => ({
  id: 'C01',
  read: { primitive: 'inspect', objectKind: 'files' },
  action: { primitive: 'edit-file', objectKind: 'files' },
  material: '翻仓库找跑不过的测试',
  motivation: 'hygiene',
  defaults: { impact: 'local-write', reversibility: 'auto' },
  ...over,
});

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

const caseOf = (ga, over = {}) => ({ ga, why: `${ga} 判不了`, subject: `片段 ${ga}`, ...over });

/** 带 unsure 的 gate 结果：跑一圈流水线用 */
const unsureVerdict = (unsure = [caseOf('GA10', { why: '认不出 36 是哪次输出的', subject: 'idea=36 行' })]) => ({
  ok: true,
  allowDo: true,
  reject: [],
  downgrade: [],
  notes: [],
  unsupported: [],
  unsure,
  hits: [],
});

function loopHarness({ plans, verdicts, decisions, arbiter, maxRewrite = 3 }) {
  const seen = { prompts: [], judgeCalls: 0, logs: [], arbiterCalls: 0, contexts: [] };
  const planList = [...plans];
  const verdictList = [...verdicts];
  const decisionList = [...decisions];
  return {
    seen,
    options: {
      maxRewrite,
      firstPrompt: '第一版提示词',
      rewritePrompt: (feedback) => `重写：${feedback.reason}`,
      stage2: async (prompt) => {
        seen.prompts.push(prompt);
        return { ok: true, plan: planList.shift() ?? plan() };
      },
      checkPlan: async () => verdictList.shift() ?? unsureVerdict(),
      judge: async () => {
        seen.judgeCalls += 1;
        return { ok: true, decision: decisionList.shift() };
      },
      buildProposal: (p, verdict) => ({ ...p, gateDowngrade: verdict.downgrade.map((one) => `[${one.ga}] ${one.why}`) }),
      onPick: () => {},
      onEmpty: () => {},
      log: (line) => seen.logs.push(line),
      arbiter: arbiter && {
        enabled: true,
        run: async (cases, ctx) => {
          seen.arbiterCalls += 1;
          seen.contexts.push(ctx);
          return arbiter(cases, ctx);
        },
      },
    },
  };
}

const doDecision = () => ({
  action: 'do',
  text: '',
  ticket: { goal: '删掉 lib/gate.js 里 36 行重复分支', brief: '删重复分支' },
  reason: '改动小且能撤回',
});

/* ── 1. gate：灰色分支进 unsure，不接受 arbiter 的分支留下 ───────────── */

test('gate 的灰色分支进 unsure：GA3 非本地类 / GA4 形状 / GA10 缺出处 / GA17 锚点都交给 arbiter', () => {
  // GA3：service 类没有查询源
  const service = checkStage2Plan(plan({ object: { kind: 'service', value: 'ssh', anchor: 'ssh.service:1' }, step2: { change: '改 ssh 配置', files: [], estLines: 0, undo: '' }, plan: { steps: [], files: [], estLines: 0 } }), { candidates: [candidate()] });
  assert.ok(service.unsure.some((one) => one.ga === 'GA3'), 'service 类要进 unsure');
  assert.equal(service.unsupported.some((one) => one.ga === 'GA3'), false, '不再直接记 unsupported');

  // GA4：锚点不是「文件:行号」
  const badAnchor = checkStage2Plan(plan({ object: { kind: 'files', value: 'lib/gate.js', anchor: 'gate 这个文件' } }), { candidates: [candidate()] });
  assert.ok(badAnchor.unsure.some((one) => one.ga === 'GA4' && /不是「文件:行号」形状/.test(one.why)));
  assert.equal(badAnchor.unsupported.some((one) => one.ga === 'GA4'), false);

  // GA4：压根没写 anchor
  const noAnchor = checkStage2Plan(plan({ object: { kind: 'files', value: 'lib/gate.js', anchor: '' } }), { candidates: [candidate()] });
  assert.ok(noAnchor.unsure.some((one) => one.ga === 'GA4' && /没给 anchor/.test(one.why)));

  // GA10：idea 里有 evidence 找不到的数字
  const noStats = checkStage2Plan(plan({ idea: 'lib/gate.js 里有 36 行重复分支，另外 55 行也是' }), { candidates: [candidate()] });
  assert.ok(noStats.unsure.some((one) => one.ga === 'GA10' && /55/.test(one.why)));

  // GA17：素材没有可认的文件锚点
  const noMaterial = checkStage2Plan(plan({ object: { kind: 'files', value: 'lib/gate.js', anchor: 'lib/gate.js:36' } }), {
    candidates: [candidate({ material: '把重复的分支收拾一下' })],
  });
  assert.ok(noMaterial.unsure.some((one) => one.ga === 'GA17'));

  // 每条送 arbiter 的条目都得有 subject，否则模型看不到「针对哪一段」
  for (const one of [...service.unsure, ...badAnchor.unsure, ...noAnchor.unsure, ...noStats.unsure, ...noMaterial.unsure]) {
    assert.ok(String(one.subject ?? '').trim().length > 0, `${one.ga} 的 unsure 条目缺 subject`);
  }
});

test('gate 不收 arbiter 的分支：能改代码判死的仍记 unsupported / 照旧拒', () => {
  // GA2 没给配对矩阵：配置永远会传 PAIR_SET，这一拍是运行时缺口，不是灰度
  const noPairs = checkStage2Plan(plan(), { candidates: [candidate()] });
  assert.ok(noPairs.unsupported.some((one) => one.ga === 'GA2'), 'GA2 缺矩阵仍归 unsupported');
  assert.equal(noPairs.unsure.some((one) => one.ga === 'GA2'), false, 'GA2 不送 arbiter');

  // 源码上钉住：这四类分支一行 unsure.push 都不许有
  assert.equal(/unsure\.push\(\{[\s\S]{0,200}?ga: 'GA2'/.test(gateSrc), false, 'GA2 不许送 arbiter');
  assert.equal(/unsure\.push\(\{[\s\S]{0,200}?ga: 'GA6'/.test(gateSrc), false, 'GA6 不许送 arbiter');
  assert.equal(/unsure\.push\(\{[\s\S]{0,200}?ga: 'GA15'/.test(gateSrc), false, 'GA15 不许送 arbiter');
  assert.equal(/unsure\.push\(\{[\s\S]{0,200}?ga: 'GA16'/.test(gateSrc), false, 'GA16 不许送 arbiter');
  // 送的那几条源码上钉住，别哪天又改回 unsupported
  for (const ga of ['GA3', 'GA4', 'GA10', 'GA17']) {
    assert.match(gateSrc, new RegExp(`unsure\\.push\\(\\{[\\s\\S]{0,120}?ga: '${ga}'`), `${ga} 的灰色分支要 unsure.push`);
  }
});

/* ── 2. 解析 ──────────────────────────────────────────────────────── */

test('parseArbiterReply：合法 JSON 照收，why 按 240 字截断', () => {
  const parsed = parseArbiterReply('```json\n{"verdicts":[{"ga":"ga4","decision":"PASS","why":"锚点够用"},{"ga":"GA10","decision":"reject","why":"数字是编的"}]}\n```');
  assert.deepEqual(parsed.verdicts, [
    { ga: 'GA4', decision: 'pass', why: '锚点够用' },
    { ga: 'GA10', decision: 'reject', why: '数字是编的' },
  ]);
  const long = parseArbiterReply(`{"verdicts":[{"ga":"GA4","decision":"pass","why":"${'拖'.repeat(400)}"}]}`);
  assert.equal(long.verdicts[0].why.startsWith('拖'.repeat(240)), true, '前 240 字原样留');
  assert.match(long.verdicts[0].why, /…\[日志截断，原文 400 字符\]/, '截断后缀跟 ga_hit 同一口径');
});

test('parseArbiterReply：坏 JSON / 缺 verdicts / 一条有效判定都没有都返回 null', () => {
  assert.equal(parseArbiterReply('我看这条还行'), null);
  assert.equal(parseArbiterReply('{"verdicts": ['), null);
  assert.equal(parseArbiterReply('{"judges":[{"ga":"GA4","decision":"pass"}]}'), null, '没有 verdicts 数组');
  assert.equal(parseArbiterReply('{"verdicts":[]}'), null, '空数组也算没判');
  assert.equal(parseArbiterReply(''), null);
  assert.equal(parseArbiterReply(null), null);
});

test('parseArbiterReply：缺字段的条目跳过，其余照用', () => {
  const parsed = parseArbiterReply(JSON.stringify({
    verdicts: [
      { decision: 'pass', why: '没写 ga' },
      { ga: 'GA4', decision: 'maybe', why: '决定不在三种里' },
      { ga: 'GATE4', decision: 'pass', why: 'ga 形状不对' },
      null,
      '字符串条目',
      { ga: 'GA17', decision: 'downgrade', why: '素材对不上' },
    ],
  }));
  assert.deepEqual(parsed.verdicts, [{ ga: 'GA17', decision: 'downgrade', why: '素材对不上' }]);
});

/* ── 3. 合并语义 ──────────────────────────────────────────────────── */

test('mergeArbiterVerdicts：pass 放行 / reject 进 reject / downgrade 进 downgrade', () => {
  const verdict = unsureVerdict([
    caseOf('GA10', { why: '数字出处认不出' }),
    caseOf('GA17', { why: '素材没锚点' }),
    caseOf('GA3', { why: 'service 类没查询源' }),
  ]);
  const merged = mergeArbiterVerdicts({
    verdict,
    verdicts: [
      { ga: 'GA10', decision: 'pass', why: '数字对得上 idea' },
      { ga: 'GA17', decision: 'reject', why: '素材跟方案不是一码事' },
      { ga: 'GA3', decision: 'downgrade', why: '服务名写错了' },
    ],
  });
  assert.deepEqual(merged.counts, { pass: 1, reject: 1, downgrade: 1, ignored: 0 });
  assert.deepEqual(merged.verdict.unsupported.map((one) => one.ga), ['GA10']);
  assert.match(merged.verdict.unsupported[0].why, /arbiter 判放行：数字对得上/);
  assert.deepEqual(merged.verdict.reject.map((one) => one.ga), ['GA17']);
  assert.equal(merged.verdict.reject[0].why, '素材跟方案不是一码事');
  // GA3 在 REWRITE_CODES 里：带上 code / originalAction，重写循环才认得出
  assert.deepEqual(
    merged.verdict.downgrade.map(({ ga, code }) => ({ ga, code })),
    [{ ga: 'GA3', code: 'GA3' }],
  );
  assert.equal(merged.verdict.downgrade[0].originalAction, 'silent', 'GA3 的 originalAction 照 gate 的表取');
  assert.match(merged.verdict.downgrade[0].why, /arbiter 判打回重写/);
  assert.deepEqual(merged.verdict.hits, ['GA17', 'GA3']);
  assert.equal(merged.verdict.ok, false, '有 reject 就不算 ok');
  assert.equal(merged.verdict.allowDo, false);
  assert.deepEqual(merged.verdict.unsure, [], '处置完的灰色条目不能留着');
  assert.equal(verdict.unsure.length, 3, '不许直接改入参');
});

test('mergeArbiterVerdicts：模型编的 GA 与对不上的条目忽略，漏判的按 unsupported 兜底', () => {
  const verdict = unsureVerdict([caseOf('GA10', { why: '数字出处认不出' })]);
  const merged = mergeArbiterVerdicts({
    verdict,
    verdicts: [
      { ga: 'GA1', decision: 'reject', why: '模型越权改 gate 判死的关' },
      { ga: 'GA10', decision: 'pass', why: '一条' },
      { ga: 'GA10', decision: 'reject', why: '多出来的第二条，队列已空' },
    ],
  });
  assert.deepEqual(merged.counts, { pass: 1, reject: 0, downgrade: 0, ignored: 2 });
  assert.equal(merged.verdict.reject.length, 0, 'arbiter 不许碰 unsure 之外的关');
  assert.equal(merged.verdict.ok, true, '被拒的判定不成立，整拍不该因此被拒');

  // 整轮没判（失败降级）：条目全按 unsupported 放行，不拦
  const failed = mergeArbiterVerdicts({ verdict: unsureVerdict([caseOf('GA4'), caseOf('GA10')]), verdicts: [] });
  assert.deepEqual(failed.verdict.unsupported.map((one) => one.ga), ['GA4', 'GA10']);
  assert.equal(failed.verdict.unsupported[0].why, 'GA4 判不了', '兜底时保留 gate 的原话');
  assert.equal(failed.verdict.ok, true);
  assert.equal(failed.verdict.allowDo, true);
});

test('mergeArbiterVerdicts：同名 ga 多条按出现顺序配对', () => {
  const verdict = unsureVerdict([caseOf('GA3', { subject: 'service ssh' }), caseOf('GA3', { subject: 'service docker' })]);
  const merged = mergeArbiterVerdicts({
    verdict,
    verdicts: [
      { ga: 'GA3', decision: 'pass', why: 'ssh 没问题' },
      { ga: 'GA3', decision: 'reject', why: 'docker 那条不对' },
    ],
  });
  assert.equal(merged.verdict.unsupported[0].why, 'arbiter 判放行：ssh 没问题');
  assert.equal(merged.verdict.reject[0].why, 'docker 那条不对');
});

/* ── 4. 跑一轮 + 失败降级 ─────────────────────────────────────────── */

test('runArbiter：agent 回合法 JSON 就用它的判定', async () => {
  const result = await runArbiter({
    cases: [caseOf('GA4'), caseOf('GA10')],
    ctx: { candidateId: 'C01', idea: '删重复分支' },
    agent: async () => ({ ok: true, text: '{"verdicts":[{"ga":"GA4","decision":"pass","why":"够"},{"ga":"GA10","decision":"pass","why":"对得上"}]}' }),
  });
  assert.equal(result.failed, null);
  assert.equal(result.sent, 2);
  assert.deepEqual(result.verdicts.map((one) => one.ga), ['GA4', 'GA10']);
});

test('runArbiter：超时 / 抛错 / 空回复 / 坏 JSON 都归一成短词，不抛', async () => {
  const timeout = await runArbiter({ cases: [caseOf('GA4')], agent: async () => { throw new Error('agent 超时（120000ms）'); } });
  assert.equal(timeout.failed, '超时');
  assert.deepEqual(timeout.verdicts, []);

  const broken = await runArbiter({ cases: [caseOf('GA4')], agent: async () => ({ ok: false, error: '调用失败：ECONNRESET' }) });
  assert.equal(broken.failed, '调用失败');

  const empty = await runArbiter({ cases: [caseOf('GA4')], agent: async () => ({ ok: false, error: '空回复' }) });
  assert.equal(empty.failed, '空回复');

  const badJson = await runArbiter({ cases: [caseOf('GA4')], agent: async () => ({ ok: true, text: '这条我判不了' }) });
  assert.equal(badJson.failed, '坏 JSON');

  const noAgent = await runArbiter({ cases: [caseOf('GA4')] });
  assert.equal(noAgent.failed, '没注入 agent');
  assert.equal(noAgent.sent, 1, '没 agent 也要如实报送了几条');
});

test('arbiter 失败时整拍不被拒：条目全按 unsupported，终审照常判', async () => {
  const h = loopHarness({
    plans: [plan()],
    verdicts: [unsureVerdict([caseOf('GA10', { why: '数字出处认不出' }), caseOf('GA17', { why: '素材没锚点' })])],
    decisions: [doDecision()],
    arbiter: async () => ({ verdicts: [], failed: '超时', total: 2, sent: 2, skipped: 0, ms: 120_000 }),
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'decided', 'arbiter 挂了也要走到终审，不许当成拒');
  assert.equal(h.seen.judgeCalls, 1);
  assert.deepEqual(outcome.verdict.unsupported.map((one) => one.ga), ['GA10', 'GA17']);
  assert.ok(h.seen.logs.includes('arbiter_case:2 条｜送 2 条｜ms:120000｜pass:0｜reject:0｜downgrade:0'), h.seen.logs.join('\n'));
  assert.ok(h.seen.logs.includes('arbiter_fail:超时｜2 条按 unsupported 放行'));
});

test('arbiter 判 reject：整拍不做，终审不叫', async () => {
  const h = loopHarness({
    plans: [plan()],
    verdicts: [unsureVerdict([caseOf('GA17', { why: '素材没锚点' })])],
    decisions: [doDecision()],
    arbiter: async () => ({
      verdicts: [{ ga: 'GA17', decision: 'reject', why: '素材是另一个仓库的 README' }],
      failed: null,
      total: 1,
      sent: 1,
      skipped: 0,
      ms: 800,
    }),
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'gateRejected');
  assert.match(outcome.why, /方案被 arbiter 拦下：\[GA17\] 素材是另一个仓库的 README/);
  assert.equal(h.seen.judgeCalls, 0, '被 arbiter 拒了就不该再花终审的钱');
  assert.ok(h.seen.logs.includes('arbiter_judge:GA17｜reject｜why:素材是另一个仓库的 README'));
  assert.ok(h.seen.logs.includes('arbiter_case:1 条｜送 1 条｜ms:800｜pass:0｜reject:1｜downgrade:0'));
});

test('arbiter 判 downgrade：打回重写一版，第二版过了才进终审', async () => {
  const h = loopHarness({
    plans: [plan(), plan({ idea: 'lib/gate.js 第 36 行那 36 行重复分支删掉' })],
    verdicts: [
      unsureVerdict([caseOf('GA3', { why: 'service 类没查询源' })]),
      { ...unsureVerdict([]), unsure: [] },
    ],
    decisions: [doDecision()],
    arbiter: async () => ({
      verdicts: [{ ga: 'GA3', decision: 'downgrade', why: '服务名应该是 ssh.service' }],
      failed: null,
      total: 1,
      sent: 1,
      skipped: 0,
      ms: 500,
    }),
  });
  const outcome = await runRewriteLoop(h.options);

  assert.equal(outcome.kind, 'decided');
  assert.equal(outcome.rewrites, 1);
  assert.equal(h.seen.judgeCalls, 1, '只有第二版进终审');
  assert.ok(h.seen.logs.some((line) => line.startsWith('stage2_rewrite:1｜by:GA3｜')), h.seen.logs.join('\n'));
  assert.match(h.seen.prompts[1], /服务名应该是 ssh\.service/, 'arbiter 的原因要进重写消息');
});

/* ── 5. maxCases 截断 ─────────────────────────────────────────────── */

test('selectArbiterCases：按 GA 编号挑，超出的记 skipped', () => {
  const cases = [
    caseOf('GA17'), caseOf('GA3'), caseOf('GA10'), caseOf('GA4'), caseOf('GA3'), caseOf('GA3'),
  ];
  const { total, picked, skipped } = selectArbiterCases(cases, 3);
  assert.equal(total, 6);
  assert.equal(skipped, 3);
  assert.deepEqual(picked.map((one) => one.ga), ['GA3', 'GA3', 'GA3'], '先按 GA 编号排，再截');
  assert.equal(selectArbiterCases(cases, 0).picked.length, 6, '0 回落默认 8，条目不够就全送');
  assert.equal(selectArbiterCases(cases, 2).picked.length, 2);
  assert.equal(ARBITER_MAX_CASES_MIN, 1);
  assert.equal(selectArbiterCases(cases, 999).picked.length, 6, '上限再大也受条目数限制');
});

test('runArbiter：超 maxCases 时提示词只带前 N 条，返回值带 skipped', async () => {
  const cases = ['GA3', 'GA4', 'GA10', 'GA17', 'GA6', 'GA2', 'GA15', 'GA16', 'GA12', 'GA1'].map((ga) => caseOf(ga));
  let prompt = '';
  const result = await runArbiter({
    cases,
    config: { maxCases: 2 },
    agent: async (text) => {
      prompt = text;
      return { ok: true, text: '{"verdicts":[{"ga":"GA1","decision":"pass","why":"x"},{"ga":"GA2","decision":"pass","why":"y"}]}' };
    },
  });
  assert.equal(result.total, 10);
  assert.equal(result.sent, 2);
  assert.equal(result.skipped, 8);
  assert.equal(prompt.includes('[GA1]'), true, '按 GA 编号最小的先送');
  assert.equal(prompt.includes('[GA12]'), false, '截掉的条目不许进提示词');
});

/* ── 6. 配置：非法值回落默认 ──────────────────────────────────────── */

test('clampArbiterMaxCases：非法 / 越界都回落默认或夹边界', () => {
  assert.equal(clampArbiterMaxCases(undefined), ARBITER_MAX_CASES_DEFAULT);
  assert.equal(clampArbiterMaxCases(null), ARBITER_MAX_CASES_DEFAULT);
  assert.equal(clampArbiterMaxCases('abc'), ARBITER_MAX_CASES_DEFAULT);
  assert.equal(clampArbiterMaxCases(0), ARBITER_MAX_CASES_DEFAULT);
  assert.equal(clampArbiterMaxCases(-3), ARBITER_MAX_CASES_DEFAULT);
  assert.equal(clampArbiterMaxCases(999), ARBITER_MAX_CASES_MAX);
  assert.equal(clampArbiterMaxCases(3.7), 3);
  assert.equal(clampArbiterMaxCases(5), 5);
});

test('clampArbiterMaxTokens：上限 4000 / 下限 500，非法回落 1500', () => {
  assert.equal(clampArbiterMaxTokens(undefined), ARBITER_MAX_TOKENS_DEFAULT);
  assert.equal(clampArbiterMaxTokens('abc'), ARBITER_MAX_TOKENS_DEFAULT);
  assert.equal(clampArbiterMaxTokens(0), ARBITER_MAX_TOKENS_DEFAULT);
  assert.equal(clampArbiterMaxTokens(100), 500);
  assert.equal(clampArbiterMaxTokens(9999), 4000);
  assert.equal(clampArbiterMaxTokens(1500), 1500);
});

test('配置：arbiter 段收进 schema / DEFAULTS / patch，maxCases 写错也不拒加载', () => {
  // maxCases 用 z.any()：写 abc 不该让整块配置拒加载，由 apply 夹
  assert.match(indexSrc, /maxCases: z\.any\(\)\.default\(ARBITER_MAX_CASES_DEFAULT\)/);
  assert.match(indexSrc, /cfg\.arbiter\.maxCases = clampArbiterMaxCases\(rawMaxCases\)/);
  assert.match(indexSrc, /clampArbiterMaxTokens\(cfg\.arbiter\.maxTokens/);
  // patch 里四段预算都写死：arbiter 1500 / effort low / 超时 120s / maxCases 8 / 只给 read
  assert.match(patchSrc, /arbiter:\n\s+enabled: true/);
  assert.match(patchSrc, /maxCases: 8/);
  assert.match(patchSrc, /reasoningEffort: low/);
  assert.match(patchSrc, /timeoutMs: 120000/);
  assert.match(patchSrc, /allow:\n\s+- read/);
  // 权限只读：arbiter 不许拿到写 / exec
  assert.match(indexSrc, /DEFAULT_ARBITER_ALLOW = \['read'\]/);
  assert.equal(/DEFAULT_ARBITER_ALLOW = \[[^\]]*'write'/.test(indexSrc), false);
});

/* ── 7. 源码：顺序与越界 ──────────────────────────────────────────── */

test('源码顺序：gate → veto → arbiter → judge，三个关各管各的', () => {
  const gateAt = rewriteSrc.indexOf('const verdict = await checkPlan(plan)');
  const vetoAt = rewriteSrc.indexOf('checkVeto(proposal');
  const arbiterAt = rewriteSrc.indexOf('await arbiter.run(unsure');
  const judgeAt = rewriteSrc.indexOf('await judge(proposal');
  assert.ok(gateAt >= 0 && vetoAt >= 0 && arbiterAt >= 0 && judgeAt >= 0, '四个调用点都要在');
  assert.ok(gateAt < vetoAt, 'gate 在 veto 前');
  assert.ok(vetoAt < arbiterAt, 'veto 在 arbiter 前');
  assert.ok(arbiterAt < judgeAt, 'arbiter 在 judge 前');

  // arbiter 只吃 gate 的 unsure，不许自己另起一份条目
  assert.match(rewriteSrc, /arbiter\.run\(unsure,/);

  // arbiter.js 里不许出现下发动作的 import / 调用
  assert.equal(/from '\.\/route\.js'/.test(arbiterSrc), false, 'arbiter 不许碰 route');
  assert.equal(/\bopenTicket\b|\bexecFile\b|\bspawn\(/.test(arbiterSrc), false, 'arbiter 不许开票、不许 exec');
  assert.match(arbiterSrc, /只许看，不许改/, '提示词里要写明只读');
  assert.match(arbiterSrc, /只输出一个 JSON 对象/, '提示词里要写明只回 JSON');
  assert.match(arbiterSrc, /"verdicts"/, '回复形状要写死在提示词里');
});

test('日志行格式固定，单行、可 grep', () => {
  assert.equal(
    arbiterCaseLine({ total: 3, sent: 2, ms: 1234, pass: 1, reject: 2, downgrade: 0 }),
    'arbiter_case:3 条｜送 2 条｜ms:1234｜pass:1｜reject:2｜downgrade:0',
  );
  assert.equal(arbiterSkipLine(5), 'arbiter_case:超 5 条已略');
  assert.equal(arbiterJudgeLine({ ga: 'ga4', decision: 'reject', why: '锚点假' }), 'arbiter_judge:GA4｜reject｜why:锚点假');
  assert.equal(arbiterJudgeLine({}), 'arbiter_judge:GA?｜unknown｜why:（没写原因）');
  assert.equal(arbiterFailLine('超时', 2), 'arbiter_fail:超时｜2 条按 unsupported 放行');
  const longLine = arbiterJudgeLine({ ga: 'GA4', decision: 'pass', why: '拖'.repeat(400) });
  assert.match(longLine, /^arbiter_judge:GA4｜pass｜why:拖{240}…\[日志截断，原文 400 字符\]$/, 'why 超 240 字要截断并注明原文长度');
});

test('提示词：只列条目与方案片段，不塞提议器的过程，也不给下发入口', () => {
  const prompt = buildArbiterPrompt(
    [caseOf('GA4', { why: 'anchor 不是文件:行号', subject: 'object.anchor=gate 这个文件' })],
    { candidateId: 'C01', idea: '删重复分支', why: '复制粘贴', object: { kind: 'files', value: 'lib/gate.js' }, anchor: 'gate 这个文件', files: ['lib/gate.js'], material: '翻仓库找跑不过的测试' },
  );
  assert.match(prompt, /1\. \[GA4\] anchor 不是文件:行号/);
  assert.match(prompt, /涉及的方案片段：object\.anchor=gate 这个文件/);
  assert.match(prompt, /"verdicts"/);
  assert.equal(/开票|exec|执行命令/.test(prompt.replace(/不动手、不开票、不执行任何命令/g, '')), false, '除了那句禁令不许再提下发');
});


/* ── 8. 空正文重试 + 路由跟随提议器 ───────────────────────────── */

test('runArbiter：空正文重试一次，拿到 JSON 就算成功', async () => {
  const prompts = [];
  const replies = [
    { ok: false, error: '没等到 assistant 文本（finish=未知，可能只出了推理没有正文）' },
    { ok: true, text: '{"verdicts":[{"ga":"GA4","decision":"pass","why":"锚点对得上"}]}' },
  ];
  const result = await runArbiter({
    cases: [caseOf('GA4')],
    agent: async (prompt) => {
      prompts.push(prompt);
      return replies[prompts.length - 1];
    },
  });
  assert.equal(result.failed, null, '重试拿到 JSON 就不该算失败');
  assert.equal(result.retried, true);
  assert.equal(prompts.length, 2, '空正文只重试一次');
  assert.equal(prompts[1], retryPrompt(prompts[0]), '第二次就是原文 + 末尾那句');
  assert.ok(prompts[1].endsWith(ARBITER_RETRY_HINT), prompts[1].slice(-40));
  assert.match(prompts[1], /直接给 JSON，别解释/, '重试提示词要再钉一句');
  assert.deepEqual(result.verdicts.map((one) => one.ga), ['GA4']);
});

test('runArbiter：两次都空才算失败，失败词是「空回复」', async () => {
  let calls = 0;
  const result = await runArbiter({
    cases: [caseOf('GA4'), caseOf('GA10')],
    agent: async () => {
      calls += 1;
      return { ok: false, error: '输出预算吃完了（finish=max-tokens），正文为空' };
    },
  });
  assert.equal(calls, 2, '只重试一次，不许无限重试');
  assert.equal(result.retried, true);
  assert.equal(result.failed, '空回复');
  assert.deepEqual(result.verdicts, []);
  assert.equal(result.sent, 2, '失败也要如实报送了几条');
});

test('runArbiter：超时 / 网络错 / 坏 JSON 不重试，别白烧钱', async () => {
  const cases = [caseOf('GA4')];
  let timeoutCalls = 0;
  const timeout = await runArbiter({ cases, agent: async () => { timeoutCalls += 1; throw new Error('超时（120000ms）'); } });
  assert.equal(timeoutCalls, 1, '超时不重试');
  assert.equal(timeout.retried, false);
  assert.equal(timeout.failed, '超时');

  let netCalls = 0;
  const net = await runArbiter({ cases, agent: async () => { netCalls += 1; return { ok: false, error: '调用失败：ECONNRESET' }; } });
  assert.equal(netCalls, 1, '网络错不重试');
  assert.equal(net.failed, '调用失败');

  let badCalls = 0;
  const bad = await runArbiter({ cases, agent: async () => { badCalls += 1; return { ok: true, text: '这条我判不了' }; } });
  assert.equal(badCalls, 1, '坏 JSON 不重试');
  assert.equal(bad.failed, '坏 JSON');
});

test('runArbiter：重试后仍是坏 JSON，failed=坏 JSON 且 retried 记上', async () => {
  let calls = 0;
  const result = await runArbiter({
    cases: [caseOf('GA4')],
    agent: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: '空回复' } : { ok: true, text: '我也说不清' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.retried, true);
  assert.equal(result.failed, '坏 JSON');
});

test('isEmptyReply：只认正文空这一类', () => {
  assert.equal(isEmptyReply('没等到 assistant 文本（finish=未知）'), true);
  assert.equal(isEmptyReply('输出预算吃完了（finish=max-tokens），正文为空'), true);
  assert.equal(isEmptyReply('空回复'), true);
  assert.equal(isEmptyReply('超时（120000ms）'), false);
  assert.equal(isEmptyReply('调用失败：ECONNRESET'), false);
  assert.equal(isEmptyReply(''), false);
});

test('retryPrompt：原文不动，只在末尾补一句', () => {
  const prompt = '只输出一个 JSON 对象，别加解释。\n';
  assert.equal(retryPrompt(prompt), `只输出一个 JSON 对象，别加解释。\n\n${ARBITER_RETRY_HINT}`);
  assert.ok(retryPrompt('abc').startsWith('abc'));
});

test('resolveArbiterRoute：arbiter 空路由跟随提议器，两边都空就留空', () => {
  const empty = resolveArbiterRoute({ provider: '', model: '', maxTokens: 1500 }, { provider: 'example-provider', model: 'example-model' });
  assert.deepEqual(empty.followed, ['provider', 'model']);
  assert.equal(empty.section.provider, 'example-provider');
  assert.equal(empty.section.model, 'example-model');
  assert.equal(empty.section.maxTokens, 1500, '别的字段不许动');

  const half = resolveArbiterRoute({ provider: 'own-provider', model: '' }, { provider: 'example-provider', model: 'example-model' });
  assert.deepEqual(half.followed, ['model'], '只补缺的那个');
  assert.equal(half.section.provider, 'own-provider');

  const full = resolveArbiterRoute({ provider: 'p', model: 'm' }, { provider: 'example-provider', model: 'example-model' });
  assert.deepEqual(full.followed, []);
  assert.equal(full.section.provider, 'p');

  const nowhere = resolveArbiterRoute({ provider: '', model: '' }, { provider: '', model: '' });
  assert.deepEqual(nowhere.followed, []);
  assert.equal(nowhere.section.provider, '', '提议器也空时别编一个出来');
});

test('arbiter_retry 日志行固定，单行可 grep', () => {
  assert.equal(arbiterRetryLine(3), 'arbiter_retry:空正文重试一次｜3 条');
  assert.equal(arbiterRetryLine(), 'arbiter_retry:空正文重试一次｜0 条');
});

test('runArbiter 里确实接了重试与路由跟随（源码断言，防以后被顺手删掉）', () => {
  assert.match(arbiterSrc, /isEmptyReply\(reply\?\.error\)/, '空正文要进重试分支');
  assert.match(arbiterSrc, /retried = true/, '重试过要留痕');
  assert.match(arbiterSrc, /ARBITER_RETRY_HINT/, '重试提示词要写死一句');
  assert.match(indexSrc, /resolveArbiterRoute\(cfg\.arbiter, cfg\.proposer\)/, 'arbiter 的空路由要跟随提议器');
});
