/**
 * Gate 单测：架构图 ② 代码规则（checkProposal）与 ③ 裁决规则（checkDecision）。
 *
 * 这一层只判断「这段回复能不能用」，所以每条都对着失败分支写：
 * 空/非空 objectHints、idea 没数字、ask 长度越界、禁词、多问句、数字无据、
 * brief 列宽、以及 parseProposal 失败一律 null。
 *
 * 另有一条等价断言：Gate 不传参时的结果必须跟旧导出函数一模一样——
 * 重构只挪实现，不改行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ASK_FORBIDDEN,
  ASK_MAX_CHARS,
  ASK_MIN_CHARS,
  BRIEF_MAX_COLUMNS,
  charLength,
  columns,
  createGate,
  isSelfReferential,
  parseDecisionReport,
  parseProposal,
  validateAskText,
  validateIdea,
} from '../lib/gate.js';
import { buildProposerPrompt, PROPOSER_MATERIALS } from '../lib/proposer.js';

/** 沿用 ask-text 里那组真实背景，数字能在 idea/why 里找到出处 */
const IDEA = 'example-db 的 jobs 表里 55 条 retry 记录该清掉';
const WHY = '原文已不存在，重放只会再标一次 done，却每轮占一个重放名额，当前队列 337 条';
const ASK =
  'example-db 的 jobs 表里有 55 条 retry 记录，它们引用的原文早就没了，' +
  '重放只会再标一次 done，却每轮占一个名额——当前队列 337 条。' +
  '清掉这批吗？清掉不可恢复，不清就继续占名额。';

/** 补到指定字符数，保持「一个问句」不变 */
const padTo = (base, n) => base.replace('清掉这批吗？', `${'啊'.repeat(Math.max(0, n - charLength(base)))}清掉这批吗？`);

test('Gate 不传参时与旧函数完全等价：行为只在搬运，没改口径', () => {
  const gate = createGate();
  assert.deepEqual(gate.checkProposal(`{"idea":"${IDEA}","why":"${WHY}"}`), parseProposal(`{"idea":"${IDEA}","why":"${WHY}"}`));
  assert.equal(gate.checkProposal('今天没事'), parseProposal('今天没事'));

  const reply = `{"action":"ask","text":"${ASK}","reason":"删了不可恢复"}`;
  assert.deepEqual(
    gate.checkDecision(reply, { idea: IDEA, why: WHY }),
    parseDecisionReport(reply, { idea: IDEA, why: WHY }),
  );
  // 构造缺省也要跟旧默认值对齐
  assert.deepEqual(gate.rules, { minChars: ASK_MIN_CHARS, maxChars: ASK_MAX_CHARS, forbidden: ASK_FORBIDDEN });
  assert.equal(gate.briefMaxColumns, BRIEF_MAX_COLUMNS);
});

test('objectHints 空表：只卡数量，不拿名词判死', () => {
  const gate = createGate({ objectHints: [] });
  assert.deepEqual(gate.checkProposal(`{"idea":"把 3 个东西改一下","why":"看着不顺眼"}`), {
    idea: '把 3 个东西改一下',
    why: '看着不顺眼',
  });
});

test('objectHints 非空表：没写对象被拒，命中名词表就过', () => {
  const gate = createGate({ objectHints: ['构建产物', '表'] });
  assert.equal(gate.checkProposal(`{"idea":"把 3 个东西改一下","why":"看着不顺眼"}`), null, '既没标识符也没名词');
  assert.deepEqual(gate.checkProposal(`{"idea":"有 3 个构建产物可以删","why":"占着空间"}`), {
    idea: '有 3 个构建产物可以删',
    why: '占着空间',
  });
  // 调用级 objectHints 仍然能覆盖构造参数
  assert.equal(gate.checkProposal(`{"idea":"把 3 个东西改一下","why":"看着不顺眼"}`, { objectHints: [] })?.idea, '把 3 个东西改一下');
});

test('material 空与非空只影响提示词，校验口径不跟着变', () => {
  assert.equal(PROPOSER_MATERIALS.length, 0, '代码里不持素材清单');
  const empty = buildProposerPrompt({ materials: [] });
  assert.equal(empty.includes('可以往这些方向想'), false, '空素材池不占位');
  assert.ok(
    buildProposerPrompt({ materials: [{ text: '看看磁盘', motivation: 'status' }] }).includes('1. 看看磁盘'),
    '有素材就列出来',
  );
  // 提示词怎么变，Gate 的判断都不该被牵连
  assert.notEqual(createGate({ objectHints: [] }).checkProposal(`{"idea":"${IDEA}","why":"${WHY}"}`), null);
});

test('idea 没数字：checkProposal 返回 null，validateIdea 说明缺什么', () => {
  const gate = createGate();
  assert.equal(gate.checkProposal('{"idea":"整理一下 dsh-ego 仓库","why":"有点乱"}'), null);
  const checked = validateIdea('整理一下 dsh-ego 仓库');
  assert.equal(checked.ok, false);
  // 提到 dsh-ego 就算自我改写，必须落到 文件:行号（G1），所以这里两条都报
  assert.deepEqual(checked.problems, ['没写数量（要动几条 / 几个 / 哪几处）', '自我改写要写文件:行号（例：lib/gate.js:36）']);
  // 空串是「今天没话说」，不算失败
  assert.deepEqual(validateIdea(''), { ok: true, problems: [] });
});

test('parseProposal 失败一律 null：非 JSON、缺字段、类型不对、输入为空', () => {
  const gate = createGate();
  for (const bad of [
    '今天没事',
    '{"idea":"只有点子"}',
    '{"why":"只有理由"}',
    '{"idea":123,"why":"类型不对"}',
    '{"idea":"a 3","why":null}',
    null,
    undefined,
  ]) {
    assert.equal(gate.checkProposal(bad), null, `该拒：${String(bad)}`);
  }
  // idea 空串是合法结果（今天没话说），不当失败
  assert.deepEqual(gate.checkProposal('{"idea":"","why":"今天没什么值得说的"}'), { idea: '', why: '今天没什么值得说的' });
});

test('ask 长度越界：不到 60 与超过 160 都整拍失败', () => {
  const gate = createGate();
  const short = padTo('example-db 的 jobs 表里 55 条记录该清。清掉这批吗？', 30);
  assert.ok(charLength(short) < ASK_MIN_CHARS);
  const shortReport = gate.checkDecision(`{"action":"ask","text":"${short}"}`, { idea: IDEA, why: WHY });
  assert.equal(shortReport.ok, false);
  assert.equal(shortReport.scope, 'ask', '被拦的是 ask 文案，不是整段 JSON');
  assert.ok(shortReport.problems.some((p) => p.includes(`不到 ${ASK_MIN_CHARS} 个字符`)));

  const long = `${ASK}${'啊'.repeat(ASK_MAX_CHARS)}`;
  assert.ok(charLength(long) > ASK_MAX_CHARS);
  const longReport = gate.checkDecision(`{"action":"ask","text":"${long}"}`, { idea: IDEA, why: WHY });
  assert.equal(longReport.ok, false);
  assert.ok(longReport.problems.some((p) => p.includes(`超过 ${ASK_MAX_CHARS} 个字符`)));

  // 边界值本身要能过
  const atMin = padTo('example-db 的 jobs 表里 55 条记录该清。清掉这批吗？', ASK_MIN_CHARS);
  assert.equal(charLength(atMin), ASK_MIN_CHARS);
  assert.equal(gate.checkDecision(`{"action":"ask","text":"${atMin}"}`, { idea: IDEA, why: WHY }).ok, true);
});

test('禁词：默认那 10 个命中就拦，整组可换', () => {
  const gate = createGate();
  for (const word of ASK_FORBIDDEN) {
    const text = padTo(ASK.replace('清掉这批吗？', `${word}清掉这批吗？`), 70);
    const report = gate.checkDecision(`{"action":"ask","text":"${text}"}`, { idea: IDEA, why: WHY });
    assert.equal(report.ok, false, `「${word}」该拦`);
    assert.ok(report.problems.some((p) => p.includes(`「${word}」`)));
  }
  // 整组替换，不是追加：换成自定义组后，默认禁词「死账」不再拦
  const custom = createGate({ ask: { forbidden: ['随便'] } });
  const withJargon = padTo(ASK.replace('清掉这批吗？', '死账清掉这批吗？'), 70);
  assert.equal(createGate().checkDecision(`{"action":"ask","text":"${withJargon}"}`, { idea: IDEA, why: WHY }).ok, false, '默认组拦「死账」');
  assert.equal(custom.checkDecision(`{"action":"ask","text":"${withJargon}"}`, { idea: IDEA, why: WHY }).ok, true);
  assert.equal(validateAskText(withJargon, { idea: IDEA, why: WHY, rules: { forbidden: ['随便'] } }).ok, true);
});

test('问句：一个才过，零个和两个都拦', () => {
  const gate = createGate();
  const none = padTo(ASK.replace('清掉这批吗？', '这批该清。'), 70);
  const noneReport = gate.checkDecision(`{"action":"ask","text":"${none}"}`, { idea: IDEA, why: WHY });
  assert.ok(noneReport.problems.some((p) => p.includes('没有明确问句')));

  const two = padTo(ASK.replace('清掉这批吗？', '清掉这批吗？还是再放一放？'), 70);
  const twoReport = gate.checkDecision(`{"action":"ask","text":"${two}"}`, { idea: IDEA, why: WHY });
  assert.ok(twoReport.problems.some((p) => p.includes('只能留一个')));
  assert.equal(gate.checkDecision(`{"action":"ask","text":"${ASK}"}`, { idea: IDEA, why: WHY }).ok, true);
});

test('ask 文案自己编的数字只记警告：这一拍仍按 ask 走，不拦死', () => {
  const gate = createGate();
  const invented = ASK.replace('当前队列 337 条', '当前队列 337 条，另外还有 999 条');
  const report = gate.checkDecision(`{"action":"ask","text":"${invented}"}`, { idea: IDEA, why: WHY });
  assert.equal(report.ok, true);
  assert.equal(report.decision.action, 'ask');
  assert.ok(report.warnings.some((w) => w.includes('999')), report.warnings.join('；'));
  // 出处查得到时不报：337 在 why 里
  assert.deepEqual(gate.checkDecision(`{"action":"ask","text":"${ASK}"}`, { idea: IDEA, why: WHY }).warnings, []);
  // 没传 evidence（= 没有可比对的来源）时只查「有没有数字」，不判无据
  assert.equal(gate.checkDecision(`{"action":"ask","text":"${ASK}"}`).ok, true);
});

test('brief 按列宽截到 34；brief 空用 goal 兜底；列宽可配', () => {
  const gate = createGate();
  const longBrief = '鲸鱼娘'.repeat(30);
  const report = gate.checkDecision(JSON.stringify({ action: 'do', ticket: { goal: '清掉 12 个备份', brief: longBrief } }));
  assert.equal(report.ok, true);
  assert.equal(BRIEF_MAX_COLUMNS, 34);
  assert.ok(columns(report.decision.ticket.brief) <= BRIEF_MAX_COLUMNS, `超了：${report.decision.ticket.brief}`);
  assert.equal(columns(report.decision.ticket.brief), BRIEF_MAX_COLUMNS, '截到刚好 34 列');

  const blank = gate.checkDecision('{"action":"do","ticket":{"goal":"清掉 12 个备份","brief":"  "}}');
  assert.equal(blank.decision.ticket.brief, '清掉 12 个备份', 'brief 空就拿 goal 兜底');

  const narrow = createGate({ briefMaxColumns: 10 });
  const narrowReport = narrow.checkDecision(JSON.stringify({ action: 'do', ticket: { goal: '清掉 12 个备份', brief: longBrief } }));
  assert.equal(columns(narrowReport.decision.ticket.brief), 10);
});

test('裁决失败分支：非 JSON、JSON 没闭合、action 非法、do 缺 goal', () => {
  const gate = createGate();
  const noJson = gate.checkDecision('这次算了');
  assert.equal(noJson.ok, false);
  assert.deepEqual(noJson.problems, ['回复里没有 JSON 对象']);

  const broken = gate.checkDecision('{"action":"ask","text":"删 55 条');
  assert.ok(broken.problems[0].includes('JSON 没闭合'), '有 { 但没配平 = 真截断');
  assert.equal(broken.scope, 'reply');

  const badAction = gate.checkDecision('{"action":"maybe","reason":"拿不准"}');
  assert.ok(badAction.problems[0].includes('action 非法'));

  const noGoal = gate.checkDecision('{"action":"do","ticket":{"goal":"","brief":"清备份"},"reason":"x"}');
  assert.deepEqual(noGoal.problems, ['action=do 但 ticket.goal 是空的']);

  const silent = gate.checkDecision('{"action":"silent","reason":"没什么可说的"}');
  assert.deepEqual(silent.decision, { action: 'silent', text: '', ticket: null, reason: '没什么可说的' });
});

test('index.js 的调用点真的走 Gate，两段都只有一处', () => {
  const index = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/adjudicator.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/round.js', import.meta.url), 'utf8')].join('\n');
  assert.equal((index.match(/createGate\(/g) ?? []).length, 1, '一拍只建一个 Gate');
  // 两阶段之后提议段拆成 stage1 规则枚举 + stage2 方案：方案解析在 parseStage2Plan，
  // 一阶段的 gate.checkProposal（只认 idea/why 两字段）不再是提议段的入口
  assert.equal((index.match(/gate\.checkProposal\(/g) ?? []).length, 0, 'stage2 之后别再调一阶段的 checkProposal');
  assert.equal((index.match(/parseStage2Plan\(/g) ?? []).length, 1, 'stage2 方案解析只有一处');
  assert.equal((index.match(/gate\.checkDecision\(/g) ?? []).length, 1, '终审那段的调用点要换成 Gate');
  assert.equal(index.includes('parseProposal('), false, 'index 里不该再直连旧函数');
  assert.equal(index.includes('parseDecisionReport('), false, 'index 里不该再直连旧函数');
});

/* ── intent 契约：撤回账本要的那一栏（E2 / G2）────────────────────── */

/** 一条正常的 do 裁决；intent 传 undefined 就是「老格式没这栏」 */
const doReport = (intent) =>
  JSON.stringify({
    action: 'do',
    ticket: {
      goal: '把 lib/window.js:12 的超时改成 30 秒',
      brief: '改超时',
      ...(intent === undefined ? {} : { intent }),
    },
    reason: '小改动，能撤回',
  });

const AUTO_INTENT = {
  reversibility: 'auto',
  impact: { paths: ['lib/window.js'], services: [], remotes: [] },
  dryRun: { ok: true, detail: 'node --test test/window.test.mjs' },
  undo: { kind: 'git-checkout', ref: 'lib/window.js', howto: 'git checkout -- lib/window.js' },
};

test('auto 档的 do 过：intent 四栏原样带进 decision.ticket', () => {
  const gate = createGate();
  const report = gate.checkDecision(doReport(AUTO_INTENT));
  assert.equal(report.ok, true);
  assert.equal(report.decision.ticket.intent.reversibility, 'auto');
  assert.deepEqual(report.decision.ticket.intent.impact.paths, ['lib/window.js']);
  assert.equal(report.decision.ticket.intent.undo.howto, 'git checkout -- lib/window.js');
  assert.equal(report.decision.ticket.intent.dryRun.ok, true);
});

test('reversibility=none 的 do 不许出：settle 就地降级成 ask，不当失败', () => {
  const gate = createGate();
  const none = {
    ...AUTO_INTENT,
    reversibility: 'none',
    impact: { paths: ['lib/window.js'], services: [], remotes: ['origin'] },
    undo: { kind: 'none', ref: 'origin/main', howto: 'already pushed to origin main, cannot rewind' },
  };
  // none 在解析层不判死——降级要改动作，不是让这一拍白跑
  const report = gate.checkDecision(doReport(none));
  assert.equal(report.ok, true);

  const settled = gate.settle(report.decision);
  assert.equal(settled.downgraded, true);
  assert.equal(settled.decision.action, 'ask');
  assert.equal(settled.decision.ticket, null);
  assert.ok(settled.decision.text.includes('撤不回来'));
  assert.ok(settled.decision.text.trim().endsWith('要开票吗？'), '降级后要有个问句交给人');
  assert.ok(settled.decision.reason.includes('none'));
  assert.equal(settled.notes.length, 1);
});

test('silent / ask 不受 intent 规矩牵连', () => {
  const gate = createGate({ intentRequired: true });
  const silent = gate.settle(gate.checkDecision('{"action":"silent","reason":"没事"}').decision);
  assert.equal(silent.downgraded, false);
  assert.equal(silent.decision.action, 'silent');

  const ask = gate.settle(gate.checkDecision(JSON.stringify({ action: 'ask', text: ASK, reason: '要她点头' }), { idea: IDEA, why: WHY }).decision);
  assert.equal(ask.downgraded, false);
  assert.equal(ask.decision.action, 'ask');
});

test('intentRequired：缺 intent 的 do 按 none 处理；默认关，老格式照旧放行', () => {
  const off = createGate();
  assert.equal(off.settle(off.checkDecision(doReport(undefined)).decision).downgraded, false, '默认关：老格式行为不变');

  const on = createGate({ intentRequired: true });
  const settled = on.settle(on.checkDecision(doReport(undefined)).decision);
  assert.equal(settled.downgraded, true);
  assert.equal(settled.decision.action, 'ask');
  assert.ok(settled.notes[0].includes('intentRequired'));
});

test('manual 但 impact 三项全空 → 拒；填一项就过', () => {
  const gate = createGate();
  const report = gate.checkDecision(
    doReport({ ...AUTO_INTENT, reversibility: 'manual', impact: { paths: [], services: [], remotes: [] } }),
  );
  assert.equal(report.ok, false);
  assert.equal(report.scope, 'intent');
  assert.ok(report.problems.some((p) => p.includes('三项全空')));

  const withPath = gate.checkDecision(
    doReport({ ...AUTO_INTENT, reversibility: 'manual', impact: { paths: ['lib/window.js'], services: [], remotes: [] } }),
  );
  assert.equal(withPath.ok, true, '不要求三栏都写，写清一类就够');
});

test('undo.howto 是空话 → 拒：空、太短、命中空话词、只有省略号', () => {
  const gate = createGate();
  for (const bad of ['', '回滚', '这个稍后手动处理一下就行了', '………………', '看情况']) {
    const report = gate.checkDecision(doReport({ ...AUTO_INTENT, undo: { kind: 'x', ref: '', howto: bad } }));
    assert.equal(report.ok, false, `该拒：${JSON.stringify(bad)}`);
    assert.equal(report.scope, 'intent');
    assert.ok(report.problems.length > 0);
  }
  // 一句真命令就过（长度下限 10 个字符）
  const ok = gate.checkDecision(
    doReport({ ...AUTO_INTENT, undo: { kind: 'restore', ref: 'lib/window.js.bak', howto: 'cp lib/window.js.bak lib/window.js' } }),
  );
  assert.equal(ok.ok, true);
});

/* ── 自我指涉（G1）──────────────────────────────────────────── */

test('自我指涉要写文件:行号：带行号过、不带行号拒、普通点子不受影响', () => {
  assert.equal(validateIdea('把 dsh-ego 的 lib/gate.js:36 那三行加个自指校验').ok, true);
  assert.equal(validateIdea('把 plugins/dsh-ego/lib/route.js:104-108 补上 origin 参数').ok, true);

  const rejected = validateIdea('把 dsh-ego 的提议器整理一下，去掉 3 处重复');
  assert.equal(rejected.ok, false);
  assert.ok(rejected.problems.some((p) => p.includes('文件:行号')));

  // 别的仓库提到 dsh-ego 之外的名字不该被牵连
  assert.equal(validateIdea('把 dsh-timer 的 3 处重复代码合成一处').ok, true);
  assert.equal(isSelfReferential('plugins/dsh-ego/lib/route.js'), true);
  assert.equal(isSelfReferential('dsh-timer/lib/route.js'), false);
});

test('降级在 routeDecision 之前：index.js 里 settle 只有一处且排在路由前面', () => {
  const index = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/adjudicator.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/round.js', import.meta.url), 'utf8')].join('\n');
  assert.equal((index.match(/gate\.settle\(/g) ?? []).length, 1, '降级只有一个入口');
  assert.ok(index.indexOf('gate.settle(') < index.indexOf('routeDecision('), '先降级再路由');
  assert.equal(index.includes('intentRequired: cfg.judge.intentRequired'), true, '灰度开关要接上配置');
});
