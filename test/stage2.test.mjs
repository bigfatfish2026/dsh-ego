/**
 * 两阶段第 3 批：stage2 提示词、方案解析、预算选项。
 *
 * 两段式之后盯四件事：
 *   1. stage2 只拿 stage1 挑出来的那一对（读格 R → 动作格 A），别的编号不许冒出来；
 *   2. 提示词要求分两步：step1 只读（read / verdict / abortIf），step2 才动；
 *   3. 解析口径照规则第八节——pick 空串只要求 idea / why；非空时 step1 三栏必填，
 *      verdict=continue 还要 object / evidence / plan；abort 时 step2 不许有；
 *   4. intent 四栏缺哪栏走 gate 的 normalizeIntent 默认，不自己补规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPACT_SLOTS,
  STAGE2_OBJECT_KINDS,
  buildStage2Prompt,
  parseStage2Plan,
} from '../lib/proposer.js';
import { OBJECT_KINDS, PRIMITIVES } from '../lib/grid.js';
import { buildStage2Options } from '../lib/agent-run.js';

const CANDIDATE = {
  id: 'C01',
  read: { primitive: 'inspect', primitiveKey: 'inspect', objectKind: 'files', objectKey: 'files' },
  action: { primitive: 'edit-file', primitiveKey: 'editFile', objectKind: 'files', objectKey: 'files' },
  material: '翻仓库找跑不过的测试',
  motivation: 'hygiene',
  note: '读 读 × 文件 → 动 改文件 × 文件｜有副作用 auto｜入口 read+grep 定位｜种子：翻仓库找跑不过的测试',
  score: 39,
  defaults: { impact: 'local-write', reversibility: 'auto' },
};

/** 单段只读那一格：A 是 null，提示词要明说「只读不动」。 */
const SINGLE = {
  id: 'C02',
  read: { primitive: 'inspect', primitiveKey: 'inspect', objectKind: 'session', objectKey: 'session' },
  action: null,
  material: '挑一个本地仓库翻翻，看有没有跑不过的测试',
  motivation: 'hygiene',
  note: '读 读 × 会话｜只读 auto｜单段读（这一拍配不出动作格）｜入口 glob/grep/read｜种子：挑一个本地仓库翻翻，看有没有跑不过的测试',
  score: 13,
  defaults: { impact: 'read', reversibility: 'auto' },
};

const plan = (overrides = {}) =>
  JSON.stringify({
    pick: 'C01',
    step1: { read: 'plugins/dsh-ego/test/ 下 3 个 .mjs 没被 package.json 引用', verdict: 'continue', abortIf: '测试脚本已经全接进去就 abort' },
    step2: { change: '把 3 个测试文件接进 npm test', files: ['package.json'], estLines: 1, undo: 'git checkout -- package.json' },
    idea: 'fatfish 有 3 个测试文件还没接进 npm test',
    why: '上个提交加了两条用例，脚本没改',
    object: { kind: 'files', value: '/srv/app/plugins/dsh-ego/test/', anchor: 'test/stage2.test.mjs:1' },
    evidence: [{ claim: '3 个测试文件没被脚本引用', source: 'grep', value: '3', at: '2026-11-10T05:28:00Z' }],
    plan: { steps: ['P1×files'], files: ['package.json'], estLines: 0 },
    intent: {
      impact: { paths: ['package.json'], services: [], remotes: [] },
      reversibility: 'auto',
      dryRun: { ok: true, detail: 'grep 过 package.json' },
      undo: { kind: 'git-checkout', ref: 'package.json', howto: 'git checkout -- package.json' },
    },
    ...overrides,
  });

/* ── 提示词 ─────────────────────────────────────────────────────── */

test('stage2 提示词只放传进来的那一对：编号、R、A、种子都在，别的编号不在', () => {
  const prompt = buildStage2Prompt([CANDIDATE], [{ text: '翻仓库找跑不过的测试', motivation: 'hygiene' }], {
    now: new Date('2026-11-10T05:30:00Z'),
    state: { lastReportAt: Date.parse('2026-11-10T04:00:00Z'), lastReason: '上一个点子' },
  });
  assert.match(prompt, /C01/);
  assert.match(prompt, /R=读 inspect×files/, '候选行要把读格写出来');
  assert.match(prompt, /A=动 edit-file×files/, '候选行要把动作格写出来');
  assert.match(prompt, /读 读 × 文件 → 动 改文件 × 文件/, '候选行的 note 要原样进提示词');
  assert.match(prompt, /step1/, '两步式的第一步要进 schema');
  assert.match(prompt, /abortIf/, '「读到什么就停」这一栏要进 schema');
  assert.match(prompt, /verdict 只有两个值：continue/, '两个结论要写死');
  assert.match(prompt, /verdict=abort 时 step2 不许写|step2 不写/, 'abort 时不许写第二步要说清');
  assert.match(prompt, /种子：翻仓库找跑不过的测试/);
  assert.match(prompt, /2026-11-10T05:30:00\.000Z/, '时间要带进去');
  assert.match(prompt, /上一个点子：上一个点子/);
  assert.match(prompt, /素材池这一拍有 1 条方向/, '素材条数要说清，别让它另找方向');
  assert.equal(/C0[2-9]/.test(prompt), false, '没传进来的候选编号一个都不许出现');
  for (const field of ['"pick"', '"idea"', '"why"', '"object"', '"evidence"', '"plan"', '"intent"']) {
    assert.ok(prompt.includes(field), `输出 schema 里要有 ${field}`);
  }
  assert.match(prompt, /intent\.impact 三栏按对象类别落/, 'impact 落哪栏要写进提示词');
  assert.match(prompt, /auto\/manual\/none/, '撤回三档要写进提示词');
});

test('stage2 提示词：字段规范写死了——object.value 纯路径、行号只在 anchor、evidence 短标识', () => {
  const prompt = buildStage2Prompt([CANDIDATE], [], {});
  // object.value 只许一个纯路径/纯标识符，禁说明文字、括号、多文件
  assert.match(prompt, /object\.value 只写一个纯路径或纯标识符/);
  assert.match(prompt, /不许带括号说明/, '括号说明要明令禁掉');
  assert.match(prompt, /不许一行里列多个文件/, '多文件要赶去 plan.files');
  assert.match(prompt, /files 类对象也一样/, 'files 类不能靠类型逃掉这条规范');
  // 行号只许出现在 anchor，且是「路径:行号」
  assert.match(prompt, /行号只许出现在 object\.anchor 里/);
  assert.match(prompt, /格式固定「路径:行号」/);
  // evidence.value 必须是短标识，不许整句
  assert.match(prompt, /evidence 每条的 value 必须是短标识/);
  assert.match(prompt, /不许整句/);
  // idea 里的数字要有 evidence 出处
  assert.match(prompt, /idea 正文里出现的每个数字都必须在某条 evidence\.value 里原样出现/);
  // 反例→正例对照：反例是 21:06 的真实写法，正例把路径/行号/evidence 分开
  assert.match(prompt, /反例 object\.value：".*app\.log 第 718 行（另含 app\.state\.json、app\.sh）"/);
  assert.match(prompt, /正例 object\.value："\/srv\/app\/logs\/app\.log"/);
  assert.match(prompt, /正例 object\.anchor："\/srv\/app\/logs\/app\.log:718"/);
  assert.match(prompt, /value":"718"/, 'idea 里的 718 要有一条 evidence 出处');
});

test('stage2 提示词：没有候选也不炸，pick 留空串', () => {
  const prompt = buildStage2Prompt([], [], {});
  assert.match(prompt, /这一拍没有候选对/);
  assert.match(prompt, /pick/);
});

/* ── 三处反复犯的毛病：kind / undo.howto / idea 数字 ─────────────── */

test('stage2 提示词：候选行把 objectKind 显式写出来，模型照抄不许换类', () => {
  const prompt = buildStage2Prompt([CANDIDATE], [], {});
  assert.match(prompt, /C01｜objectKind=files｜R=/, '候选行要带 objectKind，别让模型靠 note 猜');
  // 单段只读那一格：objectKind 取读格，A 那一栏写明只读不动
  const singlePrompt = buildStage2Prompt([SINGLE], [], {});
  assert.match(singlePrompt, /C02｜objectKind=session｜/, '单段候选的 objectKind 取读格');
  assert.match(singlePrompt, /A=动（单段读，只读不动）/, '单段候选要写明只读不动');
  assert.match(singlePrompt, /只写 step1 \+ verdict=continue，step2 一律不写/, '单段候选的写法要写死');
  assert.match(prompt, /object\.kind 必须原样照抄候选行里的 objectKind/);
  assert.match(prompt, /一字不改/);
  assert.match(prompt, /不许换成另一个类/);
  assert.match(prompt, /会被 GA2 当场拒/, '要把 GA2 的后果说明白');
});

test('stage2 提示词：八类对象名字与一句话释义都在，config 不是 files', () => {
  const prompt = buildStage2Prompt([CANDIDATE], [], {});
  for (const kind of STAGE2_OBJECT_KINDS) {
    assert.ok(prompt.includes(kind), `提示词里要有对象类「${kind}」`);
  }
  assert.match(prompt, /files 文件正文/);
  assert.match(prompt, /config 配置文件/);
  assert.match(prompt, /service 系统服务或常驻进程/);
  assert.match(prompt, /memory 长期记忆条目/);
  assert.match(prompt, /ticket 票本身/);
  assert.match(prompt, /session 会话记录/);
  assert.match(prompt, /external-doc 外部资料/);
  assert.match(prompt, /external-repo 外部仓库/);
  assert.match(prompt, /配置类和文件类在 gate 眼里是两回事/);
});

test('stage2 提示词：undo.howto 要能跑，禁省略号与空话，带正反例', () => {
  const prompt = buildStage2Prompt([CANDIDATE], [], {});
  assert.match(prompt, /intent\.undo\.howto 必须写一条实际能跑的命令/);
  assert.match(prompt, /只读方案写「只读，无改动」/);
  for (const word of ['「…」', '「略」', '「同上」', '「恢复原状」', '「见前文」']) {
    assert.ok(prompt.includes(word), `空话词 ${word} 要明令禁掉`);
  }
  assert.match(prompt, /禁只写标点/);
  assert.match(prompt, /正例：`cp \/srv\/app\/logs\/app\.log\.bak /, '要给一条真能跑的正例');
  assert.match(prompt, /反例：`…`/);
  assert.match(prompt, /checkUndoHowto 按「没有任何命令」拒掉整拍/, '要说清 gate 在哪拦');
});

test('stage2 提示词：idea 里尽量不写行号，数字必须有同一条 evidence 出处', () => {
  const prompt = buildStage2Prompt([CANDIDATE], [], {});
  assert.match(prompt, /idea 里尽量不写具体行号/);
  assert.match(prompt, /把「第 718 行」写成「唯一一行失败」/, '要给替代写法');
  assert.match(prompt, /在 evidence\.value 里有一模一样的一条/);
});

test('stage2 提示词末尾：输出前自查三条，短，不是长篇', () => {
  const prompt = buildStage2Prompt([CANDIDATE], [], {});
  const tail = prompt.slice(prompt.indexOf('输出前自查'));
  assert.ok(tail.length > 0, '末尾要有自查段');
  const block = tail.slice(0, tail.indexOf('· 只输出一个 JSON 对象'));
  assert.match(tail, /1\. object\.kind 跟候选行的 objectKind 一字不差/);
  assert.match(tail, /2\. idea 里每个数字都在某条 evidence\.value 里有一模一样的一条/);
  assert.match(tail, /3\. intent\.undo\.howto 是能跑的命令或具体路径，不是省略号/);
  assert.match(tail, /4\. step1\.read \/ verdict \/ abortIf 三栏都填了/, '两步式的第一步也要自查');
  assert.ok(block.split('\n').filter((line) => line.trim()).length <= 5, '自查段就标题加四条，别写成长篇');
  assert.ok(
    prompt.indexOf('只输出一个 JSON 对象') > prompt.indexOf('输出前自查'),
    '自查段在收尾，JSON 输出要求压在最后',
  );
});

/* ── 解析：正常路径 ─────────────────────────────────────────────── */

test('完整方案解析出来：pick / idea / why / object / evidence / plan / intent 全在', () => {
  const parsed = parseStage2Plan(plan(), { candidates: [CANDIDATE] });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.plan.pick, 'C01');
  assert.equal(parsed.plan.object.kind, 'files');
  assert.equal(parsed.plan.anchor, undefined, 'anchor 挂在 object 里，不另开顶层字段');
  assert.deepEqual(parsed.plan.plan.steps, ['P1×files']);
  assert.equal(parsed.plan.evidence.length, 1);
  assert.deepEqual(parsed.plan.intent.impact.paths, ['package.json']);
  assert.equal(parsed.plan.intent.reversibility, 'auto');
  assert.equal(parsed.plan.intent.dryRun.ok, true);
  assert.equal(parsed.plan.intent.undo.howto, 'git checkout -- package.json');
  assert.deepEqual(parsed.plan.step1, {
    read: 'plugins/dsh-ego/test/ 下 3 个 .mjs 没被 package.json 引用',
    verdict: 'continue',
    abortIf: '测试脚本已经全接进去就 abort',
  });
  assert.equal(parsed.plan.step2.change, '把 3 个测试文件接进 npm test');
  assert.deepEqual(parsed.plan.step2.files, ['package.json']);
  assert.equal(parsed.plan.step2.undo, 'git checkout -- package.json');
});

test('step2 缺写：continue 时不报 schema（由 GA15 判），abort 时 step2 保持 null', () => {
  const noStep2 = JSON.parse(plan());
  delete noStep2.step2;
  const continueOne = parseStage2Plan(JSON.stringify(noStep2), { candidates: [CANDIDATE] });
  assert.equal(continueOne.ok, true, '结构齐不齐是 gate 的 GA15 管的，解析只判形状');
  assert.equal(continueOne.plan.step2, null);

  const aborted = parseStage2Plan(
    JSON.stringify({
      pick: 'C01',
      step1: { read: 'plugins/dsh-ego/package.json', verdict: 'abort', abortIf: '脚本已经接好了就 abort' },
      idea: 'package.json 的 test 脚本已经带 glob，三个文件都在里面',
      why: '读到 test 脚本是 node --test test/*.mjs，没有漏的',
    }),
    { candidates: [CANDIDATE] },
  );
  assert.equal(aborted.ok, true, JSON.stringify(aborted));
  assert.equal(aborted.plan.step1.verdict, 'abort');
  assert.equal(aborted.plan.step2, null);
  assert.equal(aborted.plan.object, null, 'abort 时没有动作，object 可以缺');
  assert.deepEqual(aborted.plan.evidence, []);
  assert.deepEqual(aborted.plan.plan.steps, []);
});

test('step2 的 change/files/estLines/undo 并进方案：undo 补进 intent.undo.howto', () => {
  const noIntent = JSON.parse(plan());
  delete noIntent.intent;
  const parsed = parseStage2Plan(JSON.stringify(noIntent), { candidates: [CANDIDATE] });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.intent.undo.howto, 'git checkout -- package.json', 'step2.undo 补进 intent.undo.howto');
  assert.deepEqual(parsed.plan.plan.files, ['package.json'], 'step2.files 与 plan.files 合一份');
});

/* ── 解析：两步式的形状错误 ─────────────────────────────────────── */

test('step1 缺栏 / verdict 不认识：reason=schema', () => {
  for (const field of ['read', 'verdict', 'abortIf']) {
    const broken = JSON.parse(plan());
    delete broken.step1[field];
    const parsed = parseStage2Plan(JSON.stringify(broken), { candidates: [CANDIDATE] });
    assert.equal(parsed.ok, false, `step1.${field} 缺了不许过`);
    assert.equal(parsed.reason, 'schema');
  }
  const noStep1 = JSON.parse(plan());
  delete noStep1.step1;
  assert.match(parseStage2Plan(JSON.stringify(noStep1), { candidates: [CANDIDATE] }).detail, /step1/);

  const badVerdict = JSON.parse(plan());
  badVerdict.step1.verdict = 'maybe';
  assert.match(parseStage2Plan(JSON.stringify(badVerdict), { candidates: [CANDIDATE] }).detail, /continue \/ abort/);
});

test('围栏和前后废话不影响解析', () => {
  const parsed = parseStage2Plan(`我翻了一下。\n\`\`\`json\n${plan()}\n\`\`\``, { candidates: [CANDIDATE] });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.pick, 'C01');
});

test('pick 空串 = 这一格不值得做：只要求 idea 和 why，object/evidence/plan 都缺也过', () => {
  const parsed = parseStage2Plan('{"pick":"","idea":"","why":"这一格今天没什么可查的"}', { candidates: [CANDIDATE] });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.plan.pick, '');
  assert.equal(parsed.plan.idea, '');
  assert.equal(parsed.plan.object, null);
  assert.deepEqual(parsed.plan.evidence, []);
  assert.deepEqual(parsed.plan.plan.steps, []);
});

/* ── 解析：失败路径 ─────────────────────────────────────────────── */

test('不是 JSON：reason=json', () => {
  const parsed = parseStage2Plan('今天没什么可说的', { candidates: [CANDIDATE] });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'json');
});

test('pick 不在候选里：reason=pick，detail 带模型造的那个编号', () => {
  const parsed = parseStage2Plan(plan({ pick: 'C99' }), { candidates: [CANDIDATE] });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'pick');
  assert.match(parsed.detail, /C99/);
  assert.match(parsed.detail, /C01/, '要写出候选里到底有哪几个');
});

test('pick 不是字符串 / idea、why 缺：reason=schema', () => {
  assert.equal(parseStage2Plan(plan({ pick: 1 }), { candidates: [CANDIDATE] }).reason, 'schema');
  const noWhy = JSON.parse(plan());
  delete noWhy.why;
  assert.equal(parseStage2Plan(JSON.stringify(noWhy), { candidates: [CANDIDATE] }).reason, 'schema');
});

test('object 三件套缺一件、kind 不在八类里：reason=schema', () => {
  const badKind = JSON.parse(plan());
  badKind.object.kind = 'database';
  assert.match(parseStage2Plan(JSON.stringify(badKind), { candidates: [CANDIDATE] }).detail, /八类对象/);

  for (const field of ['kind', 'value', 'anchor']) {
    const broken = JSON.parse(plan());
    delete broken.object[field];
    const parsed = parseStage2Plan(JSON.stringify(broken), { candidates: [CANDIDATE] });
    assert.equal(parsed.ok, false, `${field} 缺了不许过`);
    assert.equal(parsed.reason, 'schema');
  }
});

test('evidence 空数组 / 条目没 source：reason=schema', () => {
  assert.match(parseStage2Plan(plan({ evidence: [] }), { candidates: [CANDIDATE] }).detail, /至少要一条/);
  const noSource = JSON.parse(plan());
  delete noSource.evidence[0].source;
  assert.match(parseStage2Plan(JSON.stringify(noSource), { candidates: [CANDIDATE] }).detail, /source/);
});

test('plan.steps 空：reason=schema，且 pick 非空时 plan 是必填', () => {
  assert.match(parseStage2Plan(plan({ plan: { steps: [], files: [] } }), { candidates: [CANDIDATE] }).detail, /至少要一步/);
  assert.equal(parseStage2Plan(plan({ plan: undefined }), { candidates: [CANDIDATE] }).reason, 'schema');
});

/* ── intent：缺栏走 gate 的默认，不自己造规则 ───────────────────── */

test('intent 缺栏：impact 三栏空数组、reversibility 空串、dryRun.ok=false、undo 全空', () => {
  const noIntent = JSON.parse(plan());
  delete noIntent.intent;
  delete noIntent.step2; // step2.undo 也会补进 intent.undo.howto，这里要的是「整块都没写」
  const parsed = parseStage2Plan(JSON.stringify(noIntent), { candidates: [CANDIDATE] });
  assert.equal(parsed.ok, true, '缺 intent 不算解析失败（intentRequired 的灰度在 gate 那一层）');
  assert.equal(parsed.plan.intent, null, '整块没写就是 null，normalizeIntent 的口径');

  const halfIntent = JSON.parse(plan());
  halfIntent.intent = { reversibility: 'manual', impact: { paths: ['lib/gate.js'] } };
  const half = parseStage2Plan(JSON.stringify(halfIntent), { candidates: [CANDIDATE] });
  assert.deepEqual(half.plan.intent.impact, { paths: ['lib/gate.js'], services: [], remotes: [] });
  assert.deepEqual(half.plan.intent.dryRun, { ok: false, detail: '' });
  // undo.howto 会被 step2.undo 补上（两处写的是同一条回滚命令），kind / ref 仍走默认空串
  assert.deepEqual(half.plan.intent.undo, { kind: '', ref: '', howto: 'git checkout -- package.json' });
});

test('规则 5.2 的 JSON 示例把 reversibility 写在顶层：并进 intent，别丢', () => {
  const top = JSON.parse(plan());
  delete top.intent;
  top.reversibility = 'none';
  const parsed = parseStage2Plan(JSON.stringify(top), { candidates: [CANDIDATE] });
  assert.equal(parsed.plan.intent.reversibility, 'none');
});

/* ── 两表对齐：proposer.js 里的副本与 grid.js 同源 ──────────────── */

test('STAGE2_OBJECT_KINDS 与 grid.js 的 OBJECT_KINDS 同序同值（两份副本不许漂）', () => {
  assert.deepEqual(STAGE2_OBJECT_KINDS, OBJECT_KINDS.map((one) => one.id));
});

test('IMPACT_SLOTS 覆盖 grid.js 的七个 impact 枚举，一栏不多一栏不少', () => {
  const fromGrid = [...new Set(PRIMITIVES.map((one) => one.impact))].sort();
  assert.deepEqual(Object.keys(IMPACT_SLOTS).sort(), fromGrid);
  for (const slots of Object.values(IMPACT_SLOTS)) {
    assert.ok(Array.isArray(slots));
    for (const slot of slots) assert.ok(['paths', 'services', 'remotes'].includes(slot), `${slot} 不是 intent.impact 的栏`);
  }
});

/* ── 预算：stage2MaxTokens 独立一项，0 不往宿主送 ───────────────── */

test('buildStage2Options：maxTokens 取 stage2MaxTokens，0 不往宿主送 maxTokens', () => {
  assert.equal('maxTokens' in buildStage2Options({ stage2MaxTokens: 0 }), false, '0 = 不限，只能是「不传」');
  assert.equal(buildStage2Options({ stage2MaxTokens: 1200 }).maxTokens, 1200);
  assert.equal(
    'maxTokens' in buildStage2Options({ maxTokens: 800 }),
    false,
    '不读 proposer.maxTokens，只读 stage2MaxTokens',
  );
});

test('buildStage2Options：provider / model / reasoningEffort 照旧带上，空值不带', () => {
  const options = buildStage2Options({
    provider: 'example-provider',
    model: 'example-model',
    stage2MaxTokens: 1200,
    reasoningEffort: 'low',
  });
  assert.deepEqual(options, {
    provider: 'example-provider',
    model: 'example-model',
    maxTokens: 1200,
    reasoningEffort: 'low',
  });
  assert.deepEqual(buildStage2Options({ provider: '', model: '', stage2MaxTokens: 0 }), {});
});
