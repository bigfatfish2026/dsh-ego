/**
 * 提议器单测：提示词素材池、JSON 解析（正常 / 空点子 / 缺字段 / 非 JSON）、
 * 点子必须自带「对象 + 数量」（否则终审没法判）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL_COOLDOWN_MS,
  PROPOSER_MOTIVATIONS,
  SELF_OPTIMIZE_COOLDOWN_MS,
  buildProposerPrompt,
  filterMaterialsByCooldown,
  materialCoolingKeys,
  materialKeyOf,
  normalizeMaterialCooldowns,
  normalizeMaterials,
  parseProposal,
  validateIdea,
} from '../lib/proposer.js';

test('正常解析出 idea 和 why', () => {
  const parsed = parseProposal(
    '{"idea":"把 dsh-ego README.md:12 里缺的 2 个配置项补上","why":"刚加了 3 个开关，README 还写着旧版本"}',
  );
  assert.deepEqual(parsed, {
    idea: '把 dsh-ego README.md:12 里缺的 2 个配置项补上',
    why: '刚加了 3 个开关，README 还写着旧版本',
  });
});

test('没话说：idea 空串是合法结果', () => {
  const parsed = parseProposal('{"idea":"","why":"今天没什么值得说的"}');
  assert.deepEqual(parsed, { idea: '', why: '今天没什么值得说的' });
});

test('围栏和前后废话不影响解析', () => {
  const parsed = parseProposal('我先翻了记忆。\n```json\n{"idea":"查查 fatfish 远端有没有 2 个没推的提交","why":"上次推完忘了核"}\n```');
  assert.equal(parsed.idea, '查查 fatfish 远端有没有 2 个没推的提交');
});

test('idea 没写数量或对象就不收：等于没法判', () => {
  assert.equal(
    parseProposal('{"idea":"整理一下 dsh-ego 仓库","why":"有点乱"}'),
    null,
    '没有数量',
  );
  assert.equal(
    parseProposal('{"idea":"把 3 个东西改一下","why":"看着不顺眼"}', { objectHints: ['表', '文件'] }),
    null,
    '配了词表就不能没有对象',
  );
  const missingNumber = validateIdea('整理一下 dsh-ego 仓库');
  assert.equal(missingNumber.ok, false);
  assert.ok(missingNumber.problems.some((p) => p.includes('没写数量')));
  const missingObject = validateIdea('把 3 个东西改一下', { objectHints: ['表', '文件'] });
  assert.equal(missingObject.ok, false);
  assert.ok(missingObject.problems.some((p) => p.includes('没写对象')));
  assert.equal(validateIdea('example-db 的 jobs 表里 55 条记录该清').ok, true);
  assert.equal(validateIdea('把 3 个东西改一下').ok, true, '空词表不拿名词卡对象');
  assert.equal(validateIdea('').ok, true, '空串 = 今天没话说');
});

test('缺字段、非 JSON 都返回 null', () => {
  assert.equal(parseProposal('今天没事'), null);
  assert.equal(parseProposal('{"idea":"只有点子"}'), null, '缺 why');
  assert.equal(parseProposal('{"why":"只有理由"}'), null, '缺 idea');
  assert.equal(parseProposal('{"idea":123,"why":"类型不对"}'), null);
  assert.equal(parseProposal(null), null);
});

test('提示词带上素材池、只读约束、对象+数量要求和输出格式', () => {
  const materials = [
    { text: '查查本地仓库有没有该推的提交', motivation: 'sync' },
    { text: '看看主机温度、内存、磁盘有没有异常', motivation: 'status' },
  ];
  const prompt = buildProposerPrompt({ now: new Date(2026, 10, 8, 14, 5), state: {}, materials });
  for (const [i, item] of materials.entries()) {
    assert.ok(prompt.includes(`  ${i + 1}. ${item.text}`), `缺素材编号：${item.text}`);
  }
  assert.ok(prompt.includes('只读'), '要写明只许只读');
  assert.ok(prompt.includes('不许开票') || prompt.includes('不许联系用户'));
  assert.ok(prompt.includes('必须自带对象和数量'));
  assert.ok(prompt.includes('example-db 的 jobs 表里有 55 条 retry 记录'), '正例要写进提示词');
  assert.ok(prompt.includes('反例'), '要有一个没有对象/数量的反例');
  assert.ok(prompt.includes('why 里写依据'));
  assert.ok(prompt.includes('{"idea"'));
  assert.ok(prompt.includes('（还没有记录）'), '没汇报过要写出来');
});

test('没配素材池：不列方向、不留空编号段，规矩和输出格式照旧', () => {
  const prompt = buildProposerPrompt({ now: new Date(2026, 10, 8, 14, 5), state: {} });
  assert.equal(prompt.includes('可以往这些方向想'), false);
  assert.equal(/^\s+\d+\.\s*$/m.test(prompt), false);
  assert.ok(prompt.includes('必须自带对象和数量'));
  assert.ok(prompt.includes('{"idea"'));
});

/* ── 12 小时冷却（E3）：同一方向不重复提 ─────────────────────── */

const MATERIALS = [
  { text: '陈旧的备份、日志、临时文件是不是该清了', motivation: 'hygiene' },
  { text: '优化 dsh-ego 插件自己：写成 lib/x.js:行号 + 测试文件', motivation: 'self' },
  { text: '宿主机器的状态：温度、内存、磁盘、服务、日志里有没有异常', motivation: 'status' },
];

test('冷却命中：自指点子后 12 小时内，提示词里不再有自我优化那条', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const cooled = filterMaterialsByCooldown(MATERIALS, { state: { lastSelfIdeaAt: now - 60 * 60 * 1000 }, now });
  assert.equal(cooled.cooled, 1, '只剔自我优化那条');
  assert.equal(cooled.materials.length, 2);
  assert.equal(cooled.materials.some((item) => item.text.includes('dsh-ego')), false);
  assert.equal(cooled.materials[0].text, '陈旧的备份、日志、临时文件是不是该清了', '留下的还是对象，不是 [object Object]');

  const prompt = buildProposerPrompt({ now: new Date(now), materials: cooled.materials });
  assert.equal(prompt.includes('dsh-ego'), false, '提示词里不许再出现那个方向');
  assert.ok(prompt.includes('宿主机器的状态'), '别的方向照旧列着');
});

test('冷却过期或从没提过：素材池原样不动', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const expired = filterMaterialsByCooldown(MATERIALS, { state: { lastSelfIdeaAt: now - SELF_OPTIMIZE_COOLDOWN_MS - 1000 }, now });
  assert.equal(expired.cooled, 0);
  assert.deepEqual(expired.materials, MATERIALS, '12 小时一过就恢复');

  const never = filterMaterialsByCooldown(MATERIALS, { state: {}, now });
  assert.equal(never.cooled, 0);
  assert.deepEqual(never.materials, MATERIALS, '从没提过 = 没冷却');

  // 老 state 没有这个字段也不能崩
  assert.deepEqual(filterMaterialsByCooldown(MATERIALS, { state: { lastSelfIdeaAt: 0 }, now }).materials, MATERIALS);
});

test('素材内容级冷却：同一句话 12 小时内剔掉，到期自己恢复', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const text = '陈旧的备份、日志、临时文件是不是该清了';
  const key = materialKeyOf(text);
  assert.equal(key, materialKeyOf(`  ${text}\n`), '空白/换行不影响 key');
  assert.notEqual(key, materialKeyOf('yaml / 配置里有没有没人用的项'), '不同素材不同 key');

  const hot = filterMaterialsByCooldown(MATERIALS, { state: { materialCooldowns: { [key]: now - 60 * 60 * 1000 } }, now });
  assert.equal(hot.cooled, 1, '1 小时前提过 → 只剔这一条');
  assert.equal(hot.materials.some((item) => item.text === text), false);
  assert.equal(hot.materials.length, MATERIALS.length - 1, '别的方向照旧可用');

  const expired = filterMaterialsByCooldown(MATERIALS, {
    state: { materialCooldowns: { [key]: now - MATERIAL_COOLDOWN_MS - 1000 } },
    now,
  });
  assert.equal(expired.cooled, 0, '12 小时一过自动恢复，没有永久冻死');
  assert.deepEqual(expired.materials, MATERIALS);

  // 坏 state / 老 state：当没提过
  assert.equal(normalizeMaterialCooldowns('坏值').constructor, Object);
  assert.deepEqual(normalizeMaterialCooldowns(null), {});
  assert.deepEqual(normalizeMaterialCooldowns({ '': now, x: -1, y: 'abc', z: now }), { z: now });
  assert.equal(materialCoolingKeys({ x: now - 60 * 1000 }, { now }).has('x'), true);
  assert.equal(materialCoolingKeys({ x: now - MATERIAL_COOLDOWN_MS }, { now }).has('x'), false);
  assert.equal(filterMaterialsByCooldown(MATERIALS, { state: {}, now }).cooled, 0);
});

/* ── 素材池对象形态（两阶段第一批） ─────────────────────── */

test('motivation 档位是八档，未知值不拒加载只剔条', () => {
  // 档位表唯一来源是 lib/motivations.js；这里只钉「顺序与集合」，加档要在那处加
  assert.deepEqual(PROPOSER_MOTIVATIONS, ['backlog', 'hygiene', 'sync', 'social', 'memory', 'status', 'self', 'solution']);
  const { materials, dropped } = normalizeMaterials([
    { text: '看看磁盘', motivation: 'status' },
    { text: '猜一个方向', motivation: 'whatever' },
  ]);
  assert.deepEqual(materials, [{ text: '看看磁盘', motivation: 'status' }]);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].why.includes('whatever'), '剔条日志要写清是哪个值');
});

test('缺 motivation 的条目也剔掉：两阶段按动机挑，没有标签没法走', () => {
  const { materials, dropped } = normalizeMaterials([{ text: '看看内存' }]);
  assert.deepEqual(materials, []);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].why.includes('不在档位里'));
});

test('字符串老写法不做双形态解析：整条当没有 text 剔掉，不会 stringify 成 [object Object]', () => {
  const { materials, dropped } = normalizeMaterials(['看看磁盘']);
  assert.deepEqual(materials, []);
  assert.equal(dropped[0].why, 'text 是空的');
  const prompt = buildProposerPrompt({ materials: dropped.length ? materials : [] });
  assert.equal(prompt.includes('[object Object]'), false);
});
