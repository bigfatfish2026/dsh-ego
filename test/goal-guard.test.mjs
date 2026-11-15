/**
 * 开票前的 goal 回写校验：终审写的 goal 里，路径和行号只能来自 plan 原文。
 *
 * 起因：2026-11-11 08:00 那拍，plan 的 step1.read 是 `lib/gate.js:610-612`，
 * 终审写 goal 时改成 `610-615`，票面凭空多出 3 行。这一批堵两件事：
 *   1. 终审提示词拿到 plan 原文（step1.read / step2.change / step2.files / step2.undo / object）；
 *   2. 开票前校验 goal 的路径与行号区间，对不上就整条换成 plan 原文拼的 goal。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ASK_MAX_CHARS,
  ASK_TEXT_HEAD_CHARS,
  BRIEF_MAX_COLUMNS,
  charLength,
  clampAskText,
  columns,
  createGate,
  downgradeAskText,
  goalLineRanges,
  goalPaths,
  guardGoal,
} from '../lib/gate.js';
import { buildJudgePrompt, judgeFieldNames } from '../lib/judge.js';

const HOME = '/home/tester';
const DOC = `${HOME}/fatfish/docs/x.md`;

/** stage2 的方案原文（跟线上形状一致：pick / step1 / step2 / object） */
const plan = (over = {}) => ({
  pick: 'C01',
  idea: `${DOC} 里 610-612 行有重复分支，可以删掉`,
  why: '上个提交复制粘贴留下的',
  step1: { read: `${DOC}:610-612`, verdict: 'continue', abortIf: '没有重复分支就 abort' },
  step2: {
    change: '删掉 610-612 行的重复分支',
    files: [DOC],
    estLines: 0,
    undo: `cp ${DOC}.bak ${DOC}`,
  },
  object: { kind: 'files', value: DOC, anchor: `${DOC}:610-612` },
  ...over,
});

/** 一条 do 裁决；goal/brief 按用例传 */
const doDecision = (goal, brief = '删分支') => ({
  action: 'do',
  text: '',
  ticket: { goal, brief, intent: null },
  reason: '小改动能撤回',
});

const collect = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};

/* ── 一、提示词拿到 plan 原文 ─────────────────────────────────────── */

test('终审提示词带上 plan：step1.read / step2.files / step2.undo / object 都在', () => {
  const prompt = buildJudgePrompt({ idea: plan().idea, why: plan().why, plan: plan() });
  assert.ok(prompt.includes(`${DOC}:610-612`), 'step1.read 原文要喂进去（含路径:行号）');
  assert.ok(prompt.includes('step1.read'), '要写清这是 step1.read');
  assert.ok(prompt.includes('step2.change'), '要写清这是 step2.change');
  assert.ok(prompt.includes('step2.files'), '要写清这是 step2.files');
  assert.ok(prompt.includes('删掉 610-612 行的重复分支'), 'step2.change 正文要在');
  assert.ok(prompt.includes(`cp ${DOC}.bak ${DOC}`), 'step2.undo 的命令和备份路径都要在');
  assert.ok(prompt.includes('step2.undo'), '要写清这是 step2.undo');
  assert.ok(prompt.includes('object'), 'object 那一栏要在');
  assert.ok(prompt.includes(DOC), 'object.value 要在');
  assert.ok(prompt.includes('files'), 'object.kind 要在');
  assert.ok(
    prompt.includes('你写 goal 时，路径和行号只能来自上面这些字段，不许自己编；不确定就照抄原文。'),
    '要明令路径和行号只能照抄',
  );
  // 判据文字没动
  assert.ok(prompt.includes('silent —— 什么都不做'));
  assert.ok(prompt.includes('rewrite —— 方案本身能改好'));
  assert.ok(prompt.includes('不到 1 天就 silent'));
});

test('只给 idea/why（没传 plan）也照旧能拼出提示词，空栏写「（没写）」', () => {
  const prompt = buildJudgePrompt({ idea: '把 dsh-timer 的 TODO 补完', why: 'TODO 写了三周' });
  assert.ok(prompt.includes('把 dsh-timer 的 TODO 补完'));
  assert.ok(prompt.includes('TODO 写了三周'));
  assert.ok(prompt.includes('（没写）'), '缺的 plan 栏要标成没写，不许留空让模型自己补');
  assert.equal(judgeFieldNames({ idea: 'a', why: '' }).join(','), 'idea', '空 why 不进字段名列表');
  assert.equal(
    judgeFieldNames(plan()).join(','),
    'idea,why,step1.read,step2.change,step2.files,step2.undo,object.kind,object.value',
  );
});

/* ── 二、路径校验 ─────────────────────────────────────────────────── */

test('goal 里编了一个 plan 没有的路径 → 回退成 plan 原文，日志有 goal_path_mismatch', () => {
  const { lines, log } = collect();
  const out = guardGoal(doDecision('把 /tmp/nope/other.md 的 610-612 行删掉'), plan(), { log });
  assert.equal(out.fallback, true);
  assert.ok(out.codes.includes('goal_path_mismatch:路径:/tmp/nope/other.md'), out.codes.join('；'));
  assert.ok(lines.some((line) => line.includes('goal_path_mismatch:路径:/tmp/nope/other.md')), '日志要留码');
  assert.ok(lines.some((line) => line.includes('已回退成 plan 原文拼 goal')), '日志要说清回退');
  assert.equal(out.decision.ticket.goal, `${plan().idea}\n${plan().why}`, '回退 goal = idea + 换行 + why');
  assert.equal(out.decision.action, 'do', '回退只换 goal，动作不变');
});

test('路径按后缀认：goal 写短 docs/x.md 也算命中，不误伤', () => {
  const { lines, log } = collect();
  const out = guardGoal(doDecision(`${DOC} 的 610-612 行删掉`), plan(), { log });
  assert.equal(out.fallback, false, lines.join('；'));
  assert.deepEqual(out.codes, []);
});

test('plan 写短、goal 写全路径也认（互相是后缀）', () => {
  const short = plan({ step2: { ...plan().step2, files: ['docs/x.md'] }, object: { kind: 'files', value: 'docs/x.md' }, step1: { read: 'docs/x.md:610-612', verdict: 'continue' } });
  const out = guardGoal(doDecision(`${DOC} 的 610-612 行删掉`), short, {});
  assert.equal(out.fallback, false, out.codes.join('；'));
});

test('goal 里的 ~/ 先展开再比：家目录别名不算编', () => {
  const homePlan = plan({
    step2: { ...plan().step2, files: [`${HOME}/docs/x.md`] },
    object: { kind: 'files', value: `${HOME}/docs/x.md` },
    step1: { read: `${HOME}/docs/x.md:610-612`, verdict: 'continue' },
  });
  const ok = guardGoal(doDecision('~/docs/x.md 的 610-612 行删掉'), homePlan, { home: HOME });
  assert.equal(ok.fallback, false, ok.codes.join('；'));
});

test('路径抽取：只认绝对路径，形如 /a/b/c；数字、相对路径不抽', () => {
  assert.deepEqual(goalPaths('清掉 /tmp/export/draft 里 144 个中间产物', { home: '' }), ['/tmp/export/draft']);
  assert.deepEqual(goalPaths('docs/x.md 和 lib/gate.js 都是相对路径', { home: '' }), []);
  assert.deepEqual(goalPaths('610-615 行，3 条', { home: '' }), []);
});

/* ── 三、行号区间校验 ─────────────────────────────────────────────── */

test('goal 把 610-612 改成 610-615 → 回退，日志有 goal_line_mismatch', () => {
  const { lines, log } = collect();
  const out = guardGoal(doDecision(`${DOC} 的 610-615 行删掉`), plan(), { log });
  assert.equal(out.fallback, true);
  assert.ok(out.codes.includes('goal_line_mismatch:区间:610-615'), out.codes.join('；'));
  assert.ok(lines.some((line) => line.includes('goal_line_mismatch:区间:610-615')));
  assert.ok(lines.some((line) => line.includes('已回退成 plan 原文拼 goal')));
  assert.equal(out.decision.ticket.goal, `${plan().idea}\n${plan().why}`);
});

test('行号区间能对上就不回退；:42-46 行 这种写法也认', () => {
  const ranged = plan({
    idea: 'lib/window.js 的 42-46 行超时写错了',
    why: '实测 30 秒没生效',
    step1: { read: 'lib/window.js:42-46', verdict: 'continue' },
    step2: { change: '改 42-46 行的超时', files: ['lib/window.js'], undo: 'git checkout -- lib/window.js' },
    object: { kind: 'files', value: 'lib/window.js' },
  });
  const out = guardGoal(doDecision('lib/window.js 的 :42-46 行改掉'), ranged, {});
  assert.equal(out.fallback, false, out.codes.join('；'));
  assert.deepEqual(out.decision.ticket.goal, 'lib/window.js 的 :42-46 行改掉', '命中的 goal 原样采用');
});

test('单个数字不校验：3 条 / 42 秒 不触发回退', () => {
  const out = guardGoal(doDecision(`${DOC} 的 610-612 行删掉，顺手清 3 条注释，省 42 秒`), plan(), {});
  assert.equal(out.fallback, false, out.codes.join('；'));
  assert.deepEqual(goalLineRanges('3 条注释，42 秒，144 个'), [], '不在区间里的数字不抽');
});

test('日期和时刻不当行号区间：2026-11-11 08:00 不误判', () => {
  const out = guardGoal(doDecision(`${DOC} 的 610-612 行删掉（2026-11-11 08:00 那拍）`), plan(), {});
  assert.equal(out.fallback, false, out.codes.join('；'));
  assert.deepEqual(goalLineRanges('2026-11-11 08:00 和 11-08 14:50'), []);
});

/* ── 四、回退后的 goal 与 brief ───────────────────────────────────── */

test('回退 goal 直接能开票：idea + 换行 + why；why 空就只用 idea', () => {
  const { log } = collect();
  const out = guardGoal(doDecision('/tmp/nope/x.md 的 610-615 行'), plan(), { log });
  assert.equal(out.decision.ticket.goal, `${plan().idea}\n${plan().why}`);

  const noWhy = guardGoal(doDecision('/tmp/nope/x.md 的 610-615 行'), plan({ why: '' }), { log });
  assert.equal(noWhy.decision.ticket.goal, plan({ why: '' }).idea, 'why 空就只用 idea，别留空行');
});

test('回退后 brief 照原口径：非空照旧用终审那句，空就截新 goal，不超 34 列', () => {
  const { log } = collect();
  const kept = guardGoal(doDecision('/tmp/nope/x.md 的 610-615 行', '删重复分支'), plan(), { log });
  assert.equal(kept.decision.ticket.brief, '删重复分支', '终审给了 brief 就照旧用（已截过 34 列）');

  const empty = guardGoal(doDecision('/tmp/nope/x.md 的 610-615 行', ''), plan(), { log });
  assert.ok(empty.decision.ticket.brief.length > 0, 'brief 不许空');
  assert.ok(columns(empty.decision.ticket.brief) <= BRIEF_MAX_COLUMNS, `超了：${empty.decision.ticket.brief}`);
  assert.equal(empty.decision.ticket.brief, plan().idea.slice(0, empty.decision.ticket.brief.length));
});

test('非 do 的裁决原样放过：silent / ask 不查路径行号', () => {
  const silent = { action: 'silent', text: '', ticket: null, reason: '没事' };
  const ask = { action: 'ask', text: '要动 /tmp/nope/x.md 的 610-615 行吗？', ticket: null, reason: '要问' };
  for (const decision of [silent, ask]) {
    const out = guardGoal(decision, plan(), { log: () => assert.fail('不该记日志') });
    assert.equal(out.fallback, false);
    assert.equal(out.decision, decision, '原对象原样返回');
  }
});

/* ── 五、接线：index.js 真的接上了 ────────────────────────────────── */

test('index.js 把整份 plan 交给终审，并在开票前过 guardGoal', () => {
  const index = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/adjudicator.js', import.meta.url), 'utf8')].join('\n');
  assert.equal((index.match(/guardGoal\(/g) ?? []).length, 1, 'goal 校验只有一处调用点');
  assert.ok(index.includes('guardGoal(report.decision, proposal'), '校验吃的是 plan 原文（proposal）');
  assert.ok(index.includes('plan: proposal'), 'buildJudgePrompt 要拿到整份 plan');
  assert.ok(index.includes('judge_in:'), '输入日志要记字段名列表');
  assert.ok(index.includes('judgeFieldNames(proposal)'), '字段名列表由 judgeFieldNames 产出');
});

/* ── 六、回退 goal 变长后 ask 文案要收口 ──────────────────────────── */

test('ask 文案收口：160 字符原样放过，161 截到 150 +「…」', () => {
  const exact = `${'甲'.repeat(ASK_MAX_CHARS - 1)}？`;
  assert.equal(charLength(exact), ASK_MAX_CHARS);
  assert.equal(clampAskText(exact), exact, '正好 160 不许动');

  const over = `${'甲'.repeat(ASK_MAX_CHARS)}？`;
  const clipped = clampAskText(over);
  assert.equal(charLength(clipped), ASK_TEXT_HEAD_CHARS + 1, '150 个字符 + 省略号');
  assert.ok(clipped.endsWith('…'), '收口后以省略号结尾');
  assert.ok(charLength(clipped) <= ASK_MAX_CHARS);
});

test('goal 回退成 plan 原文、settle 又降级成 ask：最终 ask 文案 ≤ 160 且以「…」结尾', () => {
  // 回退拼出来的 goal 本身远超 160：旧实现会整句塞进 ask 文案
  const longIdea = `${DOC} 里 610-612 行有重复分支，可以删掉；`
    + '旁边那三个分支也是同一个提交复制粘贴进来的，';
  const p = plan({ idea: longIdea.repeat(4), why: '上个提交复制粘贴留下的，删掉不会影响任何调用方。' });
  const { log } = collect();
  const decision = {
    ...doDecision('/tmp/nope/x.md 的 610-615 行'),
    ticket: { goal: '/tmp/nope/x.md 的 610-615 行', brief: '删分支', intent: { reversibility: 'none' } },
  };

  const guarded = guardGoal(decision, p, { log });
  assert.equal(guarded.fallback, true, 'goal 对不上 plan，先回退');
  assert.ok(charLength(guarded.decision.ticket.goal) > ASK_MAX_CHARS, '回退 goal 本身就超 160 字符');

  const settled = createGate().settle(guarded.decision);
  assert.equal(settled.downgraded, true, 'reversibility=none 要降级成 ask');
  const text = settled.decision.text;
  assert.ok(charLength(text) <= ASK_MAX_CHARS, `ask 文案 ${charLength(text)} 字符，超了 160：${text.slice(-30)}`);
  assert.ok(text.endsWith('…'), '收口后以省略号结尾');
  assert.equal(settled.askTextLen, charLength(`${guarded.decision.ticket.goal} —— 这一步撤不回来（reversibility=none），要开票吗？`), 'askTextLen 记的是收口前的原文长度');

  // 同一条路走 downgradeAskText 也是同一口径（单测直接调它）
  assert.ok(charLength(downgradeAskText(guarded.decision.ticket)) <= ASK_MAX_CHARS);
});
