/**
 * 源码级顺序/配置断言。index.js 要加载 schemastery 与 dsh-tools，单测环境装不了依赖，
 * 所以这几条只能读源码验：默认值真的没上限、点子日志真的在终审之前。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 提议段在 lib/engines/proposer.js：源码断言读 index + 提议器两份
const index = [fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/proposer.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/adjudicator.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/engines/lifecycle.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')].join('\n');
const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

test('默认配置给四段有限输出预算：judge 4000 / stage2 8000 / stage1 2000 / arbiter 1500', () => {
  // 四段 = proposer.maxTokens(2000) / proposer.stage2MaxTokens(8000) / judge.maxTokens(4000) /
  //        arbiter.maxTokens(1500)。arbiter 只回一段小 JSON，所以预算最小。
  // 旧版三段都是 UNLIMITED_MAX_TOKENS（0 = 不传 max_tokens），终审被服务端默认截断在 870 字符。
  assert.equal(index.includes('UNLIMITED_MAX_TOKENS'), false, 'index 里不许再拿 0 当「不限」');
  assert.match(index, /maxTokens: STAGE1_MAX_TOKENS_DEFAULT/, 'DEFAULTS 的 proposer.maxTokens 要有默认 2000');
  assert.match(index, /default\(STAGE2_MAX_TOKENS_DEFAULT\)/, 'schema 里 stage2MaxTokens 默认 8000');
  assert.match(index, /stage2MaxTokens: STAGE2_MAX_TOKENS_DEFAULT/, 'DEFAULTS 的 stage2MaxTokens 也默认 8000');
  assert.match(index, /maxTokens: JUDGE_MAX_TOKENS_DEFAULT/, 'DEFAULTS 的 judge.maxTokens 默认 4000');
  assert.match(index, /maxTokens = JUDGE_MAX_TOKENS_DEFAULT/, 'judge 段走 sectionBase 的默认 4000');
  assert.match(index, /maxTokens: ARBITER_MAX_TOKENS_DEFAULT/, 'DEFAULTS 的 arbiter.maxTokens 默认 1500');
  assert.match(
    index,
    /sectionBase\(DEFAULT_ARBITER_ALLOW, ARBITER_TIMEOUT_MS, ARBITER_MAX_TOKENS_DEFAULT\)/,
    'arbiter 段走 sectionBase 的默认 1500',
  );
  assert.match(index, /sectionBase\(DEFAULT_PROPOSER_ALLOW, PROPOSER_TIMEOUT_MS, STAGE1_MAX_TOKENS_DEFAULT\)/, 'proposer 段传 stage1 的 2000');
  // 三处夹取都要真接进 apply，不然配置写了也不生效
  assert.match(index, /clampJudgeMaxTokens\(cfg\.judge\.maxTokens/, 'judge.maxTokens 要过 clamp');
  assert.match(index, /clampStage1MaxTokens\(cfg\.proposer\.maxTokens/, 'proposer.maxTokens 要过 clamp');
  assert.match(index, /clampStage2MaxTokens\(cfg\.proposer\.stage2MaxTokens/, 'stage2MaxTokens 要过 clamp');
  assert.match(index, /clampArbiterMaxTokens\(cfg\.arbiter\.maxTokens/, 'arbiter.maxTokens 要过 clamp');
  // 老配置里的 0 还要能过 schema，再由 clamp 归一成默认值，不许整块拒加载
  assert.match(index, /maxTokens: z\.number\(\)\.step\(1\)\.min\(0\)/, '0 必须过得了 schema 校验');
  assert.match(index, /stage2MaxTokens: z\.number\(\)\.step\(1\)\.min\(0\)/, 'stage2MaxTokens 的 0 也要过得了 schema');
  const agentOptions = [...index.matchAll(/agentOptions: (\w+\([\w.]*\)|\w+)/g)].map((m) => m[1]);
  // 三个调用点显式带 agentOptions：stage2、终审、arbiter（建议器 stage1 已不调模型）
  assert.equal(agentOptions.length, 3, `stage2 / 终审 / arbiter 都要显式给 agentOptions，实际：${agentOptions.join('、')}`);
  assert.equal(agentOptions.filter((one) => one === 'routeOptions(section)').length, 1, '终审走 routeOptions');
  assert.equal(agentOptions.filter((one) => one === 'routeOptions(cfg.arbiter)').length, 1, 'arbiter 走自己的 routeOptions');
  assert.equal(agentOptions.filter((one) => one === 'buildStage2Options(section)').length, 1, 'stage2 那段走 buildStage2Options，预算取 stage2MaxTokens');
});

test('reasoningEffort：三段都能配，落进 agentOptions；不填就不传（arbiter 默认 low）', () => {
  assert.match(
    index,
    /reasoningEffort: z\.union\(\[z\.const\('low'\), z\.const\('high'\), z\.const\('max'\)\]\)/,
    'Section 要有 low/high/max 三档；schemastery 没有 .optional()，不填靠默认可缺省',
  );
  // 提议段拆成 stage1 + stage2 之后，只有终审和 stage2 两个调用点带 effort
  assert.equal(
    (index.match(/agentOptions: routeOptions\(section\)/g) ?? []).length,
    1,
    '终审要走 routeOptions 才带得到 effort',
  );
  assert.equal(
    (index.match(/agentOptions: routeOptions\(cfg\.arbiter\)/g) ?? []).length,
    1,
    'arbiter 要走 routeOptions(cfg.arbiter) 才带得到 effort',
  );
  assert.equal(
    (index.match(/agentOptions: buildStage2Options\(section\)/g) ?? []).length,
    1,
    'stage2 也要带 effort：buildStage2Options 内部走同一个 routeOptions',
  );
  assert.equal(index.includes("DEFAULTS"), true);
  /*
   * DEFAULTS 里 proposer / judge 都不写死 effort（不填 = 服务端默认），只有 arbiter 默认 low。
   * 用切片判，别用跨整段的懒匹配——arbiter 段就排在 judge 后面，那种写法会误伤。
   */
  const defaultsAt = index.indexOf('const DEFAULTS = {');
  const proposerAt = index.indexOf('  proposer: {', defaultsAt);
  const judgeAt = index.indexOf('  judge: {', proposerAt);
  const arbiterAt = index.indexOf('  arbiter: {', judgeAt);
  assert.ok(proposerAt > defaultsAt && judgeAt > proposerAt && arbiterAt > judgeAt, 'DEFAULTS 按 proposer / judge / arbiter 排');
  assert.equal(index.slice(proposerAt, judgeAt).includes('reasoningEffort'), false, 'proposer 段不写死 effort');
  assert.equal(index.slice(judgeAt, arbiterAt).includes('reasoningEffort'), false, 'judge 段不写死 effort');
  assert.match(index.slice(arbiterAt), /reasoningEffort: 'low'/, 'arbiter 段默认 low');
  assert.ok(patch.includes('# reasoningEffort: low'), 'patch 里给一行注释示例，不写死值');
});

test('announceTemplate：schema 校验、DEFAULTS、patch 示例三处都在', () => {
  assert.match(
    index,
    /announceTemplate: z\.string\(\)\.min\(1\)\.max\(500\)\.pattern\(\/\\S\/\)/,
    'schema 要限长度并拒纯空白',
  );
  assert.match(index, /announceTemplate: DEFAULT_ANNOUNCE_TEMPLATE/, 'DEFAULTS 也要有一份，loader 不走 schema 时兜底');
  assert.match(index, /template: cfg\.announceTemplate/, '配置要真接进自报器，别只写在 schema 里');
  assert.ok(patch.includes('# announceTemplate:'), '插件自带 patch 里给一行注释示例（可选）');
});

test('插件自带 patch 也写有限预算：proposer 2000 / stage2 8000 / judge 4000 / arbiter 1500', () => {
  const values = [...patch.matchAll(/^\s*(?:maxTokens|stage2MaxTokens):\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(values, ['2000', '8000', '4000', '1500'], `实际：${values.join(',')}`);
});

test('点子日志在终审之前：终审挂了也能在日志里看到点子', () => {
  const idea = index.indexOf('log(`点子：');
  const judged = index.indexOf('const judged = await judge(');
  assert.ok(idea > 0, '找不到点子日志');
  assert.ok(judged > 0, '找不到终审调用');
  assert.ok(idea < judged, '点子必须先在日志里落一笔，再叫终审');
});

test('开机自报的退路写清楚了：发不出去就等主会话活跃补发', () => {
  assert.match(index, /等主会话下一次活跃时补发/, '放弃重试的日志要说清退路');
  assert.match(index, /createPendingFlusher/, '主会话一活跃要能触发即时补发');
  assert.match(index, /flusher\.schedule\(\)/, '学习监听里要真调它');
});
