/**
 * 提议器单测：提示词素材池、JSON 解析（正常 / 空点子 / 缺字段 / 非 JSON）、
 * 点子必须自带「对象 + 数量」（否则裁决器没法判）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProposerPrompt,
  parseProposal,
  validateIdea,
} from '../lib/proposer.js';

test('正常解析出 idea 和 why', () => {
  const parsed = parseProposal(
    '{"idea":"把 dsh-ego README 里缺的 2 个配置项补上","why":"刚加了 3 个开关，README 还写着旧版本"}',
  );
  assert.deepEqual(parsed, {
    idea: '把 dsh-ego README 里缺的 2 个配置项补上',
    why: '刚加了 3 个开关，README 还写着旧版本',
  });
});

test('没话说：idea 空串是合法结果', () => {
  const parsed = parseProposal('{"idea":"","why":"今天没什么值得说的"}');
  assert.deepEqual(parsed, { idea: '', why: '今天没什么值得说的' });
});

test('围栏和前后废话不影响解析', () => {
  const parsed = parseProposal('我先翻了记忆。\n```json\n{"idea":"查查 dsh-ego 远端有没有 2 个没推的提交","why":"上次推完忘了核"}\n```');
  assert.equal(parsed.idea, '查查 dsh-ego 远端有没有 2 个没推的提交');
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
  assert.equal(validateIdea('dsh-ego 的 jobs 表里 55 条记录该清').ok, true);
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
  const materials = ['查查本地仓库有没有该推的提交', '看看主机温度、内存、磁盘有没有异常'];
  const prompt = buildProposerPrompt({ now: new Date(2026, 10, 8, 14, 5), state: {}, materials });
  for (const [i, line] of materials.entries()) {
    assert.ok(prompt.includes(`  ${i + 1}. ${line}`), `缺素材编号：${line}`);
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
