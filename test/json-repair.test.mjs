/**
 * extractJson 的「只差最外层一个 }」兜底，与「第一个平衡点解析不了就继续往后扫」。
 *
 * 事故一：21:18 那拍终审回复 609 字符，`{` 6 个、`}` 5 个，唯一没闭的是 offset 0 的最外层。
 * 不是流截断、不是引号问题，就是模型漏写了最外层收尾。兜底只补这一个，多缺的不猜。
 *
 * 事故二（2026-11-24 15:30 那拍 stage2，t-mwudl4vq-63w3）：模型把路径写进 step2.change 时
 * 没转义内层双引号——`"change":"…再 rm 掉"/home/x/boot-notify.sh.bak","files":[…]`。
 * 那个多余的 `"` 把字符串提前闭合，括号配对在错的位置假配平，JSON.parse 失败；旧写法
 * catch 里直接 return null，整拍白跑。现在第一个平衡点解析不了就继续往后扫。
 *
 * 真实原文来自 session c8131c5f-480b-4f98-8181-d51dd6caca6a（agentPreset=dsh-ego-proposer）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../lib/agent-run.js';
import { parseDecisionReport } from '../lib/gate.js';

/** 模拟那拍：最外层少了收尾 } */
const MISSING_OUTER = '{"action": "silent", "text": "", "ticket": {"goal": "", "brief": ""}, "reason": "今天没什么，先不动"';



/** 2026-11-24 15:30 那拍 stage2 的真实回复原文（2826 字符，与日志 out_chars 一致） */
const STAGE2_REPLY_UNQUOTED_QUOTE = "{\"pick\":\"C01\",\n \"step1\":{\"read\":\"/home/julia/fatfish/tmp/merge-20261109-105309/boot-notify.sh.bak（读到 163 行，第 4 行 CFG 指向 qqbot cordis.patch.yml，是旧脚本副本）、/home/julia/fatfish/tmp/merge-20261109-105309/pending_after_restart.sh.home.archived-20261109-105309（读到 411 行，头注释写 2026-11-06 重写），glob 该目录得 7 个文件，glob /home/julia/fatfish/tmp/trash*/* 得 0（还没有 trash 目录）\",\"verdict\":\"continue\",\"abortIf\":\"若这 7 个文件里有一个被当前配置或脚本路径引用，就 abort 不动\"},\n \"step2\":{\"change\":\"把 /home/julia/fatfish/tmp/merge-20261109-105309 整个移到新建的 /home/julia/fatfish/tmp/trash-20261124/ 下，再 rm 掉\"/home/julia/fatfish/tmp/merge-20261109-105309/boot-notify.sh.bak\",\"files\":[\"/home/julia/fatfish/tmp/merge-20261109-105309/boot-notify.sh.bak\",\"/home/julia/fatfish/tmp/merge-20261109-105309/restart-watch.sh.bak\",\"/home/julia/fatfish/tmp/merge-20261109-105309/pending_after_restart.sh.home.archived-20261109-105309\"],\"estLines\":7,\"undo\":\"mv /home/julia/fatfish/tmp/trash-20261124/merge-20261109-105309 /home/julia/fatfish/tmp/merge-20261109-105309\"},\n \"idea\":\"清掉 /home/julia/fatfish/tmp/merge-20261109-105309 下 7 个半个月前合并时留下的旧副本，boot-notify.sh.bak 到 pending_after_restart.sh 归档都在里面\",\n \"why\":\"这个目录躺了半个月没人碰：glob 得 7 个文件，读 boot-notify.sh.bak 是 163 行旧脚本副本、archived 那份 411 行头注释停在 11-06，都是改名前后的中间产物。fatfish 不是 git 仓（.git/HEAD 没命中），所以走 trash 中转再删，删完还能 mv 回来。11-13 那轮提议过但只问了主人没落地，这回直接清干净。\",\n \"object\":{\"kind\":\"files\",\"value\":\"/home/julia/fatfish/tmp/merge-20261109-105309/boot-notify.sh.bak\",\"anchor\":\"/home/julia/fatfish/tmp/merge-20261109-105309/boot-notify.sh.bak:1\"},\n \"evidence\":[{\"claim\":\"merge-20261109-105309 下文件数\",\"source\":\"glob\",\"value\":\"7\",\"at\":\"2026-11-24T07:31:00Z\"},\n  {\"claim\":\"boot-notify.sh.bak 总行数\",\"source\":\"read\",\"value\":\"163\",\"at\":\"2026-11-24T07:31:00Z\"},\n  {\"claim\":\"pending_after_restart.sh 归档总行数\",\"source\":\"read\",\"value\":\"411\",\"at\":\"2026-11-24T07:31:00Z\"},\n  {\"claim\":\"目录名里的合并日期段\",\"source\":\"glob\",\"value\":\"20261109\",\"at\":\"2026-11-24T07:31:00Z\"},\n  {\"claim\":\"目录名里的合并时刻段\",\"source\":\"glob\",\"value\":\"105309\",\"at\":\"2026-11-24T07:31:00Z\"},\n  {\"claim\":\"tmp 下尚无 trash 目录\",\"source\":\"glob\",\"value\":\"0\",\"at\":\"2026-11-24T07:31:00Z\"}],\n \"plan\":{\"steps\":[\"P1×files\",\"P6×files\"],\"files\":[\"/home/julia/fatfish/tmp/merge-20261109-105309/boot-notify.sh.bak\",\"/home/julia/fatfish/tmp/merge-20261109-105309/restart-watch.sh.bak\",\"/home/julia/fatfish/tmp/merge-20261109-105309/pending_after_restart.sh.home.archived-20261109-105309\"],\"estLines\":7},\n \"intent\":{\"impact\":{\"paths\":[\"/home/julia/fatfish/tmp/merge-20261109-105309\"],\"services\":[],\"remotes\":[]},\n  \"reversibility\":\"manual\",\"dryRun\":{\"ok\":true,\"detail\":\"glob 确认目录里正好 7 个文件、tmp 下没有 trash；read 两份正文都是旧副本，未被引用\"},\n  \"undo\":{\"kind\":\"file\",\"ref\":\"/home/julia/fatfish/tmp/trash-20261124/merge-20261109-105309\",\"howto\":\"mv /home/julia/fatfish/tmp/trash-20261124/merge-20261109-105309 /home/julia/fatfish/tmp/merge-20261109-105309\"}}}";


test('差一个 }：补上末尾那一个就解析成功，meta 带回 repaired', () => {
  const meta = {};
  const value = extractJson(MISSING_OUTER, meta);
  assert.deepEqual(value, { action: 'silent', text: '', ticket: { goal: '', brief: '' }, reason: '今天没什么，先不动' });
  assert.equal(meta.repaired, 1);
  assert.equal(meta.added, 1);
});

test('差两个 }：不补，仍返回 null，meta 不带 repaired', () => {
  const meta = {};
  const value = extractJson('{"action": "do", "ticket": {"goal": "清缓存"', meta);
  assert.equal(value, null);
  assert.equal(meta.repaired, undefined);
});

test('正常闭合：行为一个字没变，meta 不带 repaired', () => {
  const meta = {};
  const value = extractJson('{"a": 1}', meta);
  assert.deepEqual(value, { a: 1 });
  assert.equal(meta.repaired, undefined);
});

test('前面有废话 / 围栏：照旧取第一个对象，差一个 } 也能补', () => {
  assert.deepEqual(extractJson('先说两句。```json\n{"a": {"b": 2}}\n```\n再说两句'), { a: { b: 2 } });
  const meta = {};
  const value = extractJson('好，按你说的来：\n```json\n{"a": {"b": 2}', meta);
  assert.deepEqual(value, { a: { b: 2 } });
  assert.equal(meta.repaired, 1);
  // 尾巴上还剩围栏/空白就不补了：那已经不只是差一个 }，不猜
  assert.equal(extractJson('```json\n{"a": 1\n```'), null);
});

test('平衡对象后面还有内容：照旧只取第一个，不触发修补', () => {
  const meta = {};
  const value = extractJson('{"a": 1} 后面还有 {"b": 2}', meta);
  assert.deepEqual(value, { a: 1 });
  assert.equal(meta.repaired, undefined);
});

test('字符串里的括号 / 转义不受影响', () => {
  const meta = {};
  const value = extractJson('{"a": "}"}', meta);
  assert.deepEqual(value, { a: '}' });
  assert.equal(meta.repaired, undefined);
});

test('parseDecisionReport：补成功照常通过，并打一行 json_repaired 日志', () => {
  const lines = [];
  const report = parseDecisionReport(MISSING_OUTER, { log: (line) => lines.push(line) });
  assert.equal(report.ok, true, `补完应该能用，实际：${report.problems.join('；')}`);
  assert.equal(report.decision.action, 'silent');
  assert.deepEqual(lines, ['json_repaired:1｜补了末尾 1 个 }']);
});

test('parseDecisionReport：正常闭合不打 repaired 日志', () => {
  const lines = [];
  const report = parseDecisionReport('{"action": "silent", "text": "", "ticket": {"goal": "", "brief": ""}, "reason": "没事"}', {
    log: (line) => lines.push(line),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(lines, []);
});

test('parseDecisionReport：差两个 } 仍失败，报错文案不变', () => {
  const lines = [];
  const report = parseDecisionReport('{"action": "do", "ticket": {"goal": "清缓存"', { log: (line) => lines.push(line) });
  assert.equal(report.ok, false);
  assert.equal(report.decision, null);
  assert.deepEqual(report.problems, ['回复里的 JSON 没闭合（写到一半被截断，或后面的字把 } 吞了）']);
  assert.deepEqual(lines, []);
});

/* ── 第一个平衡点解析不了：继续往后扫下一个平衡点 ──────────────────── */

test('真实回复（2826 字符，路径里漏转义引号）：旧写法戳不出来的，现在要抠出 9 个 key', () => {
  assert.equal([...STAGE2_REPLY_UNQUOTED_QUOTE].length, 2826, '夹具要跟日志 out_chars 一致');
  const value = extractJson(STAGE2_REPLY_UNQUOTED_QUOTE);
  assert.notEqual(value, null, '这条回复形状是完整的，只是内层引号漏转义，不许整拍判失败');
  assert.deepEqual(Object.keys(value), [
    'pick', 'step1', 'step2', 'idea', 'why', 'object', 'evidence', 'plan', 'intent',
  ]);
  assert.equal(value.pick, 'C01');
  assert.equal(value.step1.verdict, 'continue');
});

test('两个候选平衡点：第一个配平了但解析不了，第二个能解析 → 取第二个', () => {
  // 第一个对象：字符串里夹了个没转义的引号，扫到它配平处 JSON.parse 会失败
  // 第二个对象：正常闭合
  const text = '先说一句 {"a":"x"bad","b":1} 中间又一句 {"ok":true,"n":2} 收尾';
  assert.deepEqual(extractJson(text), { ok: true, n: 2 });
});

test('全都解析不了才返回 null；一个都没有也返回 null', () => {
  assert.equal(extractJson('{"a":}'), null);
  assert.equal(extractJson('{"a" 1}'), null);
  assert.equal(extractJson('{ 乱写 }'), null);
  assert.equal(extractJson('{{{{'), null);
  assert.equal(extractJson('没有括号'), null);
});

test('引号容错只在字面解析全失败后才启用：正常回复的 meta 一个字都不带', () => {
  const meta = {};
  assert.deepEqual(extractJson('{"a": "b"}', meta), { a: 'b' });
  assert.equal(meta.quotesRepaired, undefined);
  assert.equal(meta.repaired, undefined);
  // 漏转义引号能救回来的，记一笔转义了几个引号
  const repaired = {};
  assert.deepEqual(extractJson('{"a":"x"bad","b":1}', repaired), { a: 'x"bad', b: 1 });
  assert.equal(repaired.quotesRepaired, 1);
});
