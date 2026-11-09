/**
 * 源码级顺序/配置断言。index.js 要加载 schemastery 与 dsh-tools，单测环境装不了依赖，
 * 所以这几条只能读源码验：默认值真的没上限、点子日志真的在裁决器之前。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

test('默认配置不设 maxTokens 上限：两段都用 UNLIMITED_MAX_TOKENS，不是 800/400', () => {
  assert.equal(
    (index.match(/maxTokens: UNLIMITED_MAX_TOKENS/g) ?? []).length,
    2,
    'proposer 和 judge 的 DEFAULTS 都该是不限',
  );
  assert.equal(index.includes('maxTokens: 800'), false, '800 这种上限不许再当默认');
  assert.equal(index.includes('maxTokens: 400'), false, '400 这种上限不许再当默认');
  assert.match(index, /maxTokens: z\.number\(\)\.step\(1\)\.min\(0\)/, '0 必须过得了 schema 校验');
  assert.equal(
    (index.match(/agentOptions: routeOptions\(section\)/g) ?? []).length,
    2,
    '两段都必须过 routeOptions，别又手拼 maxTokens 把 0 送给宿主',
  );
});

test('reasoningEffort：两段都能配，落进 agentOptions；不填就不传', () => {
  assert.match(
    index,
    /reasoningEffort: z\.union\(\[z\.const\('low'\), z\.const\('high'\), z\.const\('max'\)\]\)/,
    'Section 要有 low/high/max 三档；schemastery 没有 .optional()，不填靠默认可缺省',
  );
  assert.equal(
    (index.match(/agentOptions: routeOptions\(section\)/g) ?? []).length,
    2,
    'proposer 和 judge 都要走 routeOptions 才带得到 effort',
  );
  assert.equal(index.includes("DEFAULTS"), true);
  assert.equal(
    /proposer: \{\s*enabled: true,[\s\S]*?reasoningEffort:/.test(index),
    false,
    'DEFAULTS 里不许写死 effort：不填才是服务端默认',
  );
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

test('插件自带 patch 也不设上限（它会覆盖代码默认值）', () => {
  const values = [...patch.matchAll(/^\s*maxTokens:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(values, ['0', '0'], `实际：${values.join(',')}`);
});

test('点子日志在裁决器之前：裁决器挂了也能在日志里看到点子', () => {
  const idea = index.indexOf('log(`点子：');
  const judged = index.indexOf('const judged = await judge(');
  assert.ok(idea > 0, '找不到点子日志');
  assert.ok(judged > 0, '找不到裁决器调用');
  assert.ok(idea < judged, '点子必须先在日志里落一笔，再叫裁决器');
});

test('开机自报的退路写清楚了：发不出去就等主会话活跃补发', () => {
  assert.match(index, /等主会话下一次活跃时补发/, '放弃重试的日志要说清退路');
  assert.match(index, /createPendingFlusher/, '主会话一活跃要能触发即时补发');
  assert.match(index, /flusher\.schedule\(\)/, '学习监听里要真调它');
});
