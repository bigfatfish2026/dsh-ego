/**
 * GA10 数字口径的两层分工，钉住 2026-11-11 20:06 那拍踩的坑：
 *
 *   · do 方案（stage2）的 idea 里每个数字仍要有出处 —— 这是 GA10 的本职，一点不放宽；
 *   · ask 文案只是复述方案里写过的数字，出处集合要算上整份 plan（文件名、行号、计数），
 *     而且真对不上出处也只记警告：文案对不上就让整条裁决作废，代价是这一拍连问都没问出去。
 *
 * 那拍原文照抄：idea 只剩「7 份」，文案复述「.5/.6/.7」，5、6 不在 idea/why 里，
 * 旧口径判「自己加了点子/理由里没有的数字」，整拍失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askNumberSources,
  checkStage2Plan,
  createGate,
  ideaNumbersIn,
  validateAskText,
} from '../lib/gate.js';

/* ── 那拍的真实现场 ─────────────────────────────────────────────── */

const CASE_IDEA =
  'logs 下 dsh-speak-up-qq 的轮转日志还剩 7 份，插件 2026-11-08 已退役，'
  + '先删最旧三份，删前 cp 到 backups';
const CASE_WHY =
  'grep logs 与 after_restart.log 的自检行都写明「speak-up-qq 段已无」，'
  + '最后一条插件日志停在 2026-11-08；这批 gz 属于死插件的残留';
const CASE_PLAN = {
  pick: 'C01',
  idea: CASE_IDEA,
  why: CASE_WHY,
  step1: { read: 'logs 下 speak-up-qq 的轮转日志', verdict: 'continue', abortIf: '还有脚本在写就 abort' },
  step2: {
    change: '把最旧三份轮转日志 cp 到 backups 后删掉',
    files: [
      'backups/speak-up-qq.log.5.gz',
      'backups/speak-up-qq.log.6.gz',
      'backups/speak-up-qq.log.7.gz',
    ],
    undo: 'cp backups/speak-up-qq.log.5.gz logs/',
  },
  object: { kind: 'files', value: 'logs/speak-up-qq.log.5.gz' },
  evidence: [{ claim: '轮转日志还剩 7 份', source: 'read', value: 'speak-up-qq.log.7.gz', at: '2026-11-11T12:06:00Z' }],
};
const CASE_ASK =
  'fatfish/logs 下 dsh-speak-up-qq 的 .5/.6/.7 三份轮转日志，这插件 11-08 就退役了，'
  + '最后一条日志也停在 11-08，没人再写。先 cp 到 backups 再删掉这三份吗？'
  + '删完要从备份拿回来才能恢复。';

test('ask 文案复述方案里已有的数字：放行，一条警告都没有', () => {
  const result = validateAskText(CASE_ASK, { idea: CASE_IDEA, why: CASE_WHY, plan: CASE_PLAN });
  assert.equal(result.ok, true, result.problems.join('；'));
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, []);
});

test('只传 idea/why 也算有出处：5、6 从 plan 里认，日期不同写法不误判', () => {
  const known = askNumberSources({ idea: CASE_IDEA, why: CASE_WHY, plan: CASE_PLAN });
  assert.ok(known.has('5') && known.has('6') && known.has('7'), [...known].join(','));
  // 2026-11-08 与文案里的 11-08 是同一个日期坐标，遮掉后都不参与比对
  assert.deepEqual(ideaNumbersIn('2026-11-08 停了').filter((n) => n !== '08'), []);
});

test('ask 文案凭空加数字：仍是 ask，只记警告，不拦死', () => {
  const invented = CASE_ASK.replace('三份轮转日志', '三份轮转日志和 999 条别的记录');
  const result = validateAskText(invented, { idea: CASE_IDEA, why: CASE_WHY, plan: CASE_PLAN });
  assert.equal(result.ok, true, result.problems.join('；'));
  assert.ok(result.warnings.some((w) => w.includes('999')), result.warnings.join('；'));

  const gate = createGate();
  const report = gate.checkDecision(
    JSON.stringify({ action: 'ask', text: invented, reason: '删了不可恢复，只能问一句' }),
    { idea: CASE_IDEA, why: CASE_WHY, plan: CASE_PLAN },
  );
  assert.equal(report.ok, true, report.problems.join('；'));
  assert.equal(report.decision.action, 'ask');
  assert.ok(report.warnings.length > 0);
});

test('do 方案 idea 里编数字：GA10 收进一条汇总 unsure 交 arbiter，不再自己判', () => {
  const candidate = {
    id: 'C01',
    read: { primitive: 'inspect', primitiveKey: 'inspect', objectKind: 'files', objectKey: 'files' },
    action: { primitive: 'delete', primitiveKey: 'delete', objectKind: 'files', objectKey: 'files' },
    material: '翻仓库找无引用的残留文件',
    motivation: 'hygiene',
    defaults: { impact: 'local-write', reversibility: 'manual' },
  };
  const stage2 = {
    pick: 'C01',
    idea: 'lib/gate.js 里有 36 行重复分支，另外 718 行也是',
    why: '重复分支堆在一起不好维护',
    steps: ['P1×files', 'P3×files'],
    step1: { read: 'lib/gate.js:36-70', verdict: 'continue', abortIf: '没有重复分支就 abort' },
    step2: { change: '删掉重复分支', files: ['lib/gate.js'], undo: 'git checkout -- lib/gate.js' },
    object: { kind: 'files', value: 'lib/gate.js' },
    evidence: [{ claim: '重复分支在第 36 行', source: 'read', value: '36', at: '2026-11-10T05:28:00Z' }],
    intent: { impact: { local: 'lib/gate.js 变小' }, reversibility: 'auto' },
  };
  const verdict = checkStage2Plan(stage2, { candidates: [candidate] });
  const ga10 = verdict.unsure.filter((one) => one.ga === 'GA10');
  assert.equal(ga10.length, 1, '缺的数字汇成一条，不一个数字一条');
  assert.match(ga10[0].why, /718/);
  assert.equal(/36/.test(ga10[0].why), false, '36 有出处，不该被点名');
  assert.equal(verdict.downgrade.some((one) => one.ga === 'GA10'), false, '判不了的交给 arbiter');
});
