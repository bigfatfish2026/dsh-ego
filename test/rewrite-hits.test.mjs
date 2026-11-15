/**
 * 重写 followup 带哪一轮的 GA 明细：这一版被谁拦、拦在哪个字段、该怎么补。
 *
 * 2026-11-11 12:46 那拍的教训：三次重写 tools 全是 0，followup 只带「原因原文 + 上一版字段」，
 * 模型照着一条原因改完，同一批 GA7/GA10 原样活到 rewrite_exhausted。
 * 这里盯六件事：
 *   1. 一段里同时出现这一轮 GA6/GA7/GA10 的 why 原文；
 *   2. 修法按 GA 编号给：GA6 reversibility 与 GA6 impact.paths 是两句不同的话；
 *   3. GA10 那条把具体数字列进去（37.7）；
 *   4. unsupported 的不进这一段（那些不拦）；
 *   5. 每次重写带当轮 ga_hits，不是第一轮的；
 *   6. 整段 1200 字封顶，超了按 GA 顺序砍并写「（还有 N 条已省略）」；
 *   7. GA7 的模板从 gate 的模板表取，proposer 里没有另抄一份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { UNDO_TEMPLATE_HINTS, undoTemplateHint } from '../lib/gate.js';
import { REWRITE_HITS_MAX_CHARS, buildStage2RewritePrompt, rewriteBlockingHits, rewriteGaFix } from '../lib/proposer.js';
import { runRewriteLoop } from '../lib/rewrite.js';

/* ── 夹具：20:46 那拍的真实方案与 ga_hits ─────────────────────────── */

const realPlan = (over = {}) => ({
  pick: 'C01',
  step1: { read: 'read ~/.dsh/config.yml', verdict: 'abort', abortIf: '并发上限已经是 2 就 abort' },
  step2: { change: '把 config.yml 里的并发上限改小一格', undo: '改回来就行' },
  idea: '主机现在 37.7℃，并发上限 4 有点顶，调小一格稳一点',
  why: '读配置时看到并发上限和散热余量对不上',
  object: { kind: 'config', value: '/srv/app/config.yml', anchor: '' },
  evidence: [{ claim: '配置里并发上限是 4', source: 'read', value: '4', at: '2026-11-11T12:47:00Z' }],
  plan: { steps: ['P1×config', 'P3×config'], files: ['/srv/app/config.yml'], estLines: 1 },
  intent: {
    reversibility: 'auto',
    impact: { paths: [], services: [], remotes: [] },
    dryRun: { ok: true, detail: 'read config.yml' },
    undo: { kind: '', ref: '', howto: '改回来就行' },
  },
  ...over,
});

const GA6_REVERSIBILITY = 'reversibility 写宽了：候选 C01 的默认档是 manual，方案写的是 auto';
const GA6_PATHS = 'intent.impact.paths 是空的：候选 C01 的默认影响面是 local-write，要填路径';
const GA7_WHY = 'undo.howto 没命中 edit-config 的撤回模板（例：cp ~/.dsh/x.yml ~/.dsh/x.yml.bak && 改回原键），先问一句再动手';
const GA10_WHY = 'idea 里的数字 37.7 在 evidence 的 value 里找不到出处';

/** 那拍的 verdict：4 条降级 + 3 条未核 */
const realVerdict = () => ({
  ok: true,
  allowDo: false,
  reject: [],
  downgrade: [
    { ga: 'GA6', code: 'GA6', originalAction: 'silent', why: GA6_REVERSIBILITY },
    { ga: 'GA6', code: 'GA6', originalAction: 'silent', why: GA6_PATHS },
    { ga: 'GA7', code: 'GA7', originalAction: 'ask', why: GA7_WHY },
    { ga: 'GA10', code: 'GA10', originalAction: 'silent', why: GA10_WHY },
  ],
  unsupported: [
    { ga: 'GA4', why: '方案没给 anchor，行号这一条没核' },
    { ga: 'GA10', why: '只核了 idea 数字与 evidence[].value 的字面覆盖，没跟工具输出对账' },
    { ga: 'GA17', why: '素材里没有可认的文件锚点（只有方向描述）' },
  ],
  hits: ['GA6', 'GA7', 'GA10'],
});

const feedback = (over = {}) => ({
  source: 'GA6',
  ga: 'GA6',
  code: 'GA6',
  reason: GA6_REVERSIBILITY,
  idea: realPlan().idea,
  why: realPlan().why,
  files: realPlan().plan.files,
  plan: realPlan(),
  verdict: realVerdict(),
  ...over,
});

const okVerdict = () => ({ ok: true, allowDo: true, reject: [], downgrade: [], unsupported: [], notes: [], hits: [] });

/* ── 1. 一段里同时出现这一轮三条 why 原文 ─────────────────────────── */

test('一次重写 followup 里同时出现 GA6/GA7/GA10 的 why 原文', () => {
  const message = buildStage2RewritePrompt(feedback());
  assert.match(message, /这一版被拦的地方/);
  assert.match(message, /逐条怎么改/);
  assert.ok(message.includes(GA6_REVERSIBILITY), 'GA6 reversibility 原文要在');
  assert.ok(message.includes(GA6_PATHS), 'GA6 impact.paths 原文要在');
  assert.ok(message.includes(GA7_WHY), 'GA7 原文要在');
  assert.ok(message.includes(GA10_WHY), 'GA10 原文要在');
  // 逐条列表的形状：GA 编号 + 竖线 + 原话
  assert.match(message, /· GA6｜reversibility 写宽了：候选 C01 的默认档是 manual，方案写的是 auto/);
});

/* ── 2. 修法按 GA 编号匹配：GA6 两条各给各的 ──────────────────────── */

test('修法表按 GA 编号匹配：GA6 reversibility 与 GA6 impact.paths 给不同修法', () => {
  const plan = realPlan();
  const reversibility = rewriteGaFix('GA6', GA6_REVERSIBILITY, plan);
  const paths = rewriteGaFix('GA6', GA6_PATHS, plan);
  assert.match(reversibility, /把 intent\.reversibility 改成候选的默认档/);
  assert.match(paths, /把这次真要动的文件绝对路径填进 intent\.impact\.paths，别留空/);
  assert.notEqual(reversibility, paths);

  // 服务名 / 远端仓库也按 why 里指的那一栏给，不串到 paths
  assert.match(rewriteGaFix('GA6', 'intent.impact.services 是空的：候选 C02 的默认影响面是 service', plan), /intent\.impact\.services/);
  assert.match(rewriteGaFix('GA6', 'intent.impact.remotes 是空的：候选 C03 的默认影响面是 irreversible', plan), /intent\.impact\.remotes/);

  const message = buildStage2RewritePrompt(feedback());
  assert.match(message, /· GA6：把 intent\.reversibility 改成候选的默认档/);
  assert.match(message, /· GA6：把这次真要动的文件绝对路径填进 intent\.impact\.paths/);
});

/* ── 3. GA10 把具体数字列进去 ─────────────────────────────────────── */

test('GA10 的修法把 idea 里没出处的数字列出来（37.7）', () => {
  const fix = rewriteGaFix('GA10', GA10_WHY, realPlan());
  assert.match(fix, /idea 里的数字 37\.7 在 evidence\[\]\.value 里没有出处/);
  assert.match(fix, /value 就写这个数字本身、claim 写它从哪来/);
  assert.match(fix, /改成定性说法/);
  const message = buildStage2RewritePrompt(feedback());
  assert.match(message, /· GA10：idea 里的数字 37\.7 在 evidence\[\]\.value 里没有出处/);
  // 已经有出处的数字（4，在 evidence[].value 里）不列进来
  assert.doesNotMatch(fix, /数字 4[、，]/);
});

/* ── 4. unsupported 不进这一段 ───────────────────────────────────── */

test('unsupported 的 ga_hit 不进「被拦的地方」（那些不拦）', () => {
  const verdict = realVerdict();
  for (const hit of rewriteBlockingHits(verdict)) {
    assert.notEqual(hit.ga, 'GA4');
    assert.doesNotMatch(hit.why, /没给 anchor/);
    assert.doesNotMatch(hit.why, /没跟工具输出对账/);
    assert.doesNotMatch(hit.why, /素材里没有可认的文件锚点/);
  }
  const message = buildStage2RewritePrompt(feedback());
  assert.doesNotMatch(message, /方案没给 anchor/);
  assert.doesNotMatch(message, /认不出哪个数字出自哪次输出/);
  assert.doesNotMatch(message, /素材里没有可认的文件锚点/);
  // 只有 unsupported 的 verdict（judge 触发那轮常见）→ 整段不出现，不硬塞空表
  const onlyUnsupported = buildStage2RewritePrompt(feedback({ verdict: { reject: [], downgrade: [], unsupported: verdict.unsupported } }));
  assert.doesNotMatch(onlyUnsupported, /这一版被拦的地方/);
  assert.doesNotMatch(onlyUnsupported, /逐条怎么改/);
  // 不触发重写的普通降级（GA11/GA13，没 code）也不算「拦」
  assert.deepEqual(rewriteBlockingHits({ downgrade: [{ ga: 'GA11', why: '峰价' }, { ga: 'GA13', why: '同素材' }] }), []);
});

/* ── 5. 每轮带当轮 ga_hits，不沿用第一轮的 ───────────────────────── */

test('第二轮重写带第二轮的新 ga_hits，不是第一轮的', async () => {
  const prompts = [];
  const verdicts = [
    // 第一版：GA6 reversibility + impact.paths
    { ...okVerdict(), allowDo: false, hits: ['GA6'], downgrade: [{ ga: 'GA6', code: 'GA6', originalAction: 'silent', why: GA6_REVERSIBILITY }] },
    // 第二轮：GA6 改好了，剩 GA7 + GA10
    { ...okVerdict(), allowDo: false, hits: ['GA7', 'GA10'], downgrade: [
      { ga: 'GA7', code: 'GA7', originalAction: 'ask', why: GA7_WHY },
      { ga: 'GA10', code: 'GA10', originalAction: 'silent', why: GA10_WHY },
    ] },
    // 第三轮：GA10 改好了，清
    okVerdict(),
  ];
  const decisions = [{ action: 'do', ticket: { goal: '调并发上限', brief: '调并发', intent: realPlan().intent }, reason: '能撤' }];
  // 这一版 stage2 自己写的是 continue（abort 的那版到不了 judge，见 rewrite.js 的 abort 分支）
  const continuing = realPlan({ step1: { read: 'read ~/.dsh/config.yml', verdict: 'continue', abortIf: '并发上限已是 2 就 abort' } });
  const outcome = await runRewriteLoop({
    maxRewrite: 3,
    firstPrompt: '第一版提示词',
    rewritePrompt: (fb) => buildStage2RewritePrompt(fb),
    stage2: async (prompt) => {
      prompts.push(prompt);
      return { ok: true, plan: continuing };
    },
    checkPlan: async () => verdicts.shift(),
    judge: async () => ({ ok: true, decision: decisions.shift() }),
    buildProposal: (plan) => ({ ...plan }),
  });
  assert.equal(outcome.kind, 'decided');
  assert.equal(prompts.length, 3);

  // 第 1 次重写：只有第一轮的 GA6
  assert.ok(prompts[1].includes(GA6_REVERSIBILITY));
  assert.doesNotMatch(prompts[1], /· GA7｜/);
  assert.doesNotMatch(prompts[1], /· GA10｜/);

  // 第 2 次重写：带第二轮新出的 GA7/GA10，第一轮那条 GA6 不能再出现
  assert.ok(prompts[2].includes(GA7_WHY), '第二轮要带 GA7 原文');
  assert.ok(prompts[2].includes(GA10_WHY), '第二轮要带 GA10 原文');
  assert.ok(!prompts[2].includes(GA6_REVERSIBILITY), '第二轮不许沿用第一轮的 GA6');
});

/* ── 6. 1200 字封顶 ──────────────────────────────────────────────── */

test('整段超 1200 字按 GA 顺序截断，并写「（还有 N 条已省略）」', () => {
  const longWhy = (ga) => `${ga} 这一关的拦截原因：${'写得很长的一句话。'.repeat(12)}`;
  const downgrade = ['GA1', 'GA2', 'GA3', 'GA6', 'GA8', 'GA10', 'GA12', 'GA15', 'GA16', 'GA17']
    .map((ga) => ({ ga, code: ga, originalAction: 'silent', why: longWhy(ga) }));
  const message = buildStage2RewritePrompt(feedback({ verdict: { reject: [], downgrade, unsupported: [] } }));
  const section = message.slice(message.indexOf('这一版被拦的地方'), message.indexOf('硬要求：')).trim();
  assert.ok([...section].length <= REWRITE_HITS_MAX_CHARS, `整段要 ≤${REWRITE_HITS_MAX_CHARS} 字，实得 ${[...section].length}`);
  const omitted = section.match(/（还有 (\d+) 条已省略）/);
  assert.ok(omitted, '截断后要写省略条数');
  assert.ok(Number(omitted[1]) > 0);
  // 按 GA 编号顺序保留前面的，砍的是后面几条
  assert.match(section, /· GA1｜/);
  assert.doesNotMatch(section, /· GA17｜/);
});

/* ── 7. GA7 模板取自 gate，不另抄一份 ─────────────────────────────── */

test('GA7 修法的模板从 gate 的撤回模板表取，proposer 里没有另抄一份', () => {
  const source = fs.readFileSync(new URL('../lib/proposer.js', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*undoHintForPlan[^}]*\} from '\.\/gate\.js'/s, 'proposer 要从 gate 取模板');
  assert.ok(!source.includes('改回原键'), 'proposer 不许另抄 edit-config 模板原文');
  assert.ok(!source.includes('git checkout -- lib/xxx.js'), 'proposer 不许另抄 edit-file 模板原文');

  const hint = undoTemplateHint('edit-config');
  assert.equal(hint, UNDO_TEMPLATE_HINTS['edit-config']);
  const fix = rewriteGaFix('GA7', GA7_WHY, realPlan());
  assert.ok(fix.includes(hint), `GA7 修法要带上 gate 的模板原文：${hint}`);
  assert.match(fix, /照 edit-config 的模板/);

  const message = buildStage2RewritePrompt(feedback());
  assert.ok(message.includes(hint));
});

/* ── 7b. plan.steps 空（20:46 那拍 plan_steps:0）也要认得出动作类型 ── */

test('plan.steps 为空时，GA7 模板按候选动作格认（那拍就是 0 步 + edit-config）', () => {
  const zeroStep = realPlan({ plan: { steps: [], files: ['/srv/app/config.yml'], estLines: 0 } });
  const candidates = [{
    id: 'C01',
    read: { primitive: 'inspect', objectKind: 'config' },
    action: { primitive: 'edit-config', objectKind: 'config' },
    motivation: 'backlog',
    defaults: { impact: 'local-write', reversibility: 'manual' },
  }];
  const fix = rewriteGaFix('GA7', GA7_WHY, zeroStep, candidates);
  assert.ok(fix.includes(UNDO_TEMPLATE_HINTS['edit-config']), '候选格是 edit-config，就该给 edit-config 的模板');
  assert.match(fix, /照 edit-config 的模板/);
  // 候选与 steps 都没有 → 退回通用说法，不猜模板
  assert.doesNotMatch(rewriteGaFix('GA7', GA7_WHY, realPlan({ plan: { steps: [], files: [], estLines: 0 } }), []), /的模板/);
});

/* ── 8. 兜底自查句与空 verdict ───────────────────────────────────── */

test('重写提示词带兜底自查：idea 数字要能在 evidence[].value 里字面找到', () => {
  const message = buildStage2RewritePrompt(feedback({ verdict: okVerdict() }));
  assert.match(message, /改完自己过一遍：idea 里每个数字都能在 evidence\[\]\.value 里找到字面相同的值/);
  assert.doesNotMatch(message, /这一版被拦的地方/, 'judge 触发的重写没有 gate 拦截项，不硬塞空段');
});

test('rewriteFieldLines 摊出这一版已有的 evidence[].value（GA10 要对着改）', () => {
  const message = buildStage2RewritePrompt(feedback());
  assert.match(message, /· evidence\[\]\.value：4$/m);
});
