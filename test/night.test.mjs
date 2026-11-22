/**
 * 夜间模式的单测（纯函数 + 假 store，不联网、不碰 dsh、不碰真库）
 *
 * 覆盖：
 *   · 夜间窗口只在 quietStart~quietEnd 且 nightMode 打开时成立；
 *   · 白天/安静时段的既有判定一字不变；
 *   · 夜间 ask 落池的行长什么样、同一条重复出现只入池一次；
 *   · nightTicket 不被 pendingTtlMinutes 的 TTL 清掉（say/ticket 照旧被清）；
 *   · 早上的 drain 三条闸（窗口 / 主会话在不在 / 闲不闲）；
 *   · 汇总只拼一条、空账不发。
 *
 * 落库那一段用假 store：真的 BacklogStore 由 dsh-backlog 提供，测试环境不该依赖
 * 兄弟插件目录存在，所以 createNightPool 支持注入 openStore。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inNight, inQuiet, speakingWindow } from '../lib/window.js';
import {
  ASK_TITLE_MAX,
  askHash,
  askMarker,
  asksInPool,
  backlogIdInGoal,
  buildAskRow,
  buildDigestText,
  canDrainNight,
  createNightPool,
  limitReached,
  nightKeyOf,
} from '../lib/night.js';
import { enqueuePending, pendingCount } from '../lib/pending-queue.js';
import { prunePending } from '../lib/state.js';

const at = (y, m, d, h, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s, 0);
const cfg = { quietStart: 23.66, quietEnd: 8, offPeakOnly: true, holidays: [], nightMode: true };

/** 一个只活在内存里的假存储层：形状与 dsh-backlog 的 BacklogStore 对齐（list/upsert/db.close） */
function fakeStore(rows = []) {
  const items = rows.map((one) => ({ ...one }));
  return {
    items,
    list: () => items.map((one) => ({ ...one })),
    upsert: (input) => {
      if (input.id) {
        const index = items.findIndex((one) => one.id === input.id);
        if (index < 0) throw new Error(`工单 ${input.id} 不存在`);
        const existing = items[index];
        const tickets = new Set(existing.ticketIds ?? []);
        for (const one of input.tickets ?? []) tickets.add(one);
        items[index] = {
          ...existing,
          title: input.title ?? existing.title,
          status: input.status ?? existing.status,
          note: input.note ?? existing.note,
          ticketIds: [...tickets],
        };
        return { id: input.id, action: 'updated' };
      }
      const id = `bl-test-${items.length + 1}`;
      items.push({ id, title: input.title, status: input.status, note: input.note, ticketIds: input.tickets ?? [] });
      return { id, action: 'created' };
    },
    db: { close: () => {} },
  };
}

/* ── 夜间窗口 ───────────────────────────────────────────── */

test('夜间窗口：23:40~08:00 之内才算夜间，且要 nightMode 打开', () => {
  assert.equal(inNight(at(2026, 11, 21, 23, 39), cfg), false, '23:39 还没进安静时段');
  assert.equal(inNight(at(2026, 11, 21, 23, 40), cfg), true, '23:40 起算');
  assert.equal(inNight(at(2026, 11, 22, 3, 15), cfg), true, '半夜在窗口内');
  assert.equal(inNight(at(2026, 11, 22, 7, 59), cfg), true, '7:59 还在窗口内');
  assert.equal(inNight(at(2026, 11, 22, 8, 0), cfg), false, '8 点整解除');
  assert.equal(inNight(at(2026, 11, 22, 13, 0), cfg), false, '白天不是夜间');
});

test('夜间窗口：nightMode=false 时完全不成立（一键关掉就回老行为）', () => {
  const off = { ...cfg, nightMode: false };
  assert.equal(inNight(at(2026, 11, 22, 3, 0), off), false);
  // 老口径不变：安静时段照样算「不能开口」
  assert.equal(speakingWindow(at(2026, 11, 22, 3, 0), off).ok, false);
});

test('夜间窗口：quietStart 与 quietEnd 相同 = 不启用，夜间也不成立', () => {
  const none = { ...cfg, quietStart: 8, quietEnd: 8 };
  assert.equal(inQuiet(at(2026, 11, 22, 3, 0), 8, 8), false);
  assert.equal(inNight(at(2026, 11, 22, 3, 0), none), false);
});

test('白天行为不受影响：speakingWindow 的峰价/安静判定与接入夜间前一致', () => {
  assert.equal(speakingWindow(at(2026, 11, 23, 10, 0), cfg).ok, false, '周一 10 点峰价');
  assert.equal(speakingWindow(at(2026, 11, 22, 23, 45), cfg).ok, false, '安静时段仍不开口（只是另走夜间分支）');
  assert.equal(speakingWindow(at(2026, 11, 22, 20, 0), cfg).ok, true, '谷价白天照常能跑');
});

/* ── ask 落池 ───────────────────────────────────────────── */

test('askHash：同一份提议+同一句话哈希稳定，换一个就变', () => {
  const a = askHash({ idea: '夜间跑起来', text: '要不要开' });
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(askHash({ idea: '夜间跑起来', text: '要不要开' }), a, '稳定');
  assert.notEqual(askHash({ idea: '夜间跑起来', text: '要不要关' }), a, '文本变了哈希就变');
});

test('buildAskRow：状态待办、标题带[夜]、备注写清来源/理由/提议/原文/去重标记', () => {
  const row = buildAskRow({
    text: '要不要把夜间跑起来',
    idea: '夜间半价跑 ego',
    why: '半价时段空着可惜',
    reason: '这一步要人点头',
    now: Date.parse('2026-11-22T03:00:00Z'),
  });
  assert.equal(row.status, '待办');
  assert.ok(row.title.startsWith('[夜] '), '标题前缀');
  assert.ok([...row.title].length <= ASK_TITLE_MAX + 1, '标题不超长');
  assert.match(row.note, /来源=ego夜间/);
  assert.match(row.note, /理由=这一步要人点头/);
  assert.match(row.note, /提议=夜间半价跑 ego/);
  assert.match(row.note, /why=半价时段空着可惜/);
  assert.match(row.note, /原文=要不要把夜间跑起来/);
  assert.ok(row.note.includes(askMarker(row.hash)), '带去重标记');
});

test('buildAskRow：标题取裁决那句话，太长就截断', () => {
  const row = buildAskRow({ text: '很长'.repeat(60), idea: '点子', hash: 'abcdefabcdef' });
  assert.ok([...row.title].length <= ASK_TITLE_MAX + 1);
  assert.ok(row.title.endsWith('…'));
});

test('ask 入池：第一次新建，同一条再来只算 duplicate，不写第二条', async () => {
  const store = fakeStore();
  const pool = createNightPool({ openStore: async () => store });
  const row = buildAskRow({ text: '要不要开夜间', idea: '夜间照跑', now: 1 });
  const first = await pool.putAsk(row);
  const second = await pool.putAsk(row);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true, '同一条不重复入池');
  assert.equal(second.id, first.id);
  assert.equal(store.items.length, 1, '池里只有一条');
});

test('ask 入池：池里已有同 hash 的条目也算重复（重启后照样去重）', async () => {
  const row = buildAskRow({ text: '要不要开夜间', idea: '夜间照跑', hash: 'deadbeef0000' });
  const store = fakeStore([{ id: 'bl-old-1', title: '老条目', status: '待办', note: row.note, ticketIds: [] }]);
  const pool = createNightPool({ openStore: async () => store });
  const again = await pool.putAsk(row);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, 'bl-old-1');
  assert.equal(store.items.length, 1);
});

test('ask 入池：存储层炸了也不抛，返回 ok:false 让调用方退化处理', async () => {
  const pool = createNightPool({
    openStore: async () => {
      throw new Error('库打不开');
    },
  });
  const result = await pool.putAsk(buildAskRow({ text: 'x', idea: 'y' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /库打不开/);
});

test('asksInPool：按 note 里的标记认，不按标题认', () => {
  const hash = askHash({ idea: 'a', text: 'b' });
  assert.equal(asksInPool([{ title: '同名标题', note: '无标记' }], hash), false);
  assert.equal(asksInPool([{ title: '别的标题', note: `x｜${askMarker(hash)}` }], hash), true);
});

/* ── do 进 nightTicket ─────────────────────────────────── */

test('nightTicket 不过期：pendingTtlMinutes 清得掉 say/ticket，清不掉夜里的票', () => {
  const state = {};
  const longAgo = 1000;
  enqueuePending(state, 'say', { text: '一句老话', at: longAgo });
  enqueuePending(state, 'ticket', { goal: '老的活', brief: '老票面', callId: 'c-old', at: longAgo });
  enqueuePending(state, 'nightTicket', { goal: '夜里的活', brief: '夜票面', callId: 'c-night', at: longAgo });
  const now = longAgo + 2 * 60 * 60 * 1000; // 两小时后
  prunePending(state, now, 30);
  assert.equal(pendingCount(state, 'say'), 0, 'say 照旧过期');
  assert.equal(pendingCount(state, 'ticket'), 0, 'ticket 照旧过期');
  assert.equal(pendingCount(state, 'nightTicket'), 1, '夜里的票不许被 TTL 吃掉');
});

test('nightTicket 队列字段独立：不影响白天两类队列的内容', () => {
  const state = {};
  enqueuePending(state, 'nightTicket', { goal: 'g', brief: 'b', callId: 'c1', at: 1 });
  assert.deepEqual(state.pendingNightTicketQueue.map((one) => one.callId), ['c1']);
  assert.equal(pendingCount(state, 'say'), 0, '白天的话队列没被碰到');
  assert.equal(pendingCount(state, 'ticket'), 0, '白天的票队列没被碰到');
});

test('drain 闸：窗口没恢复 / 主会话不在 / 主会话在忙，都不许提', () => {
  assert.equal(canDrainNight({ windowOk: false, agent: { status: 'idle' } }), false, '夜间不提');
  assert.equal(canDrainNight({ windowOk: true, agent: undefined }), false, '主会话不在活表');
  assert.equal(canDrainNight({ windowOk: true, agent: null }), false, '同上');
  assert.equal(canDrainNight({ windowOk: true, agent: { status: 'running' } }), false, '主会话正忙');
  assert.equal(canDrainNight({ windowOk: true, agent: { status: 'waiting' } }), false, '别的非 idle 状态也不行');
});

test('drain 闸：窗口恢复且主会话 idle（或没有 status 字段）才放行', () => {
  assert.equal(canDrainNight({ windowOk: true, agent: { status: 'idle' } }), true);
  assert.equal(canDrainNight({ windowOk: true, agent: {} }), true, 'status 未定义按空闲处理（跟 findAgent 的语义一致）');
});

test('票号回填：池里有这条工单就并进 ticket_ids，没有就回报错、不新建', async () => {
  const store = fakeStore([{ id: 'bl-mwabc-1', title: '老工单', status: '待办', note: 'n', ticketIds: [] }]);
  const pool = createNightPool({ openStore: async () => store });
  const ok = await pool.attachTicket({ backlogId: 'bl-mwabc-1', ticketId: 't-mwtest01-abcd' });
  assert.equal(ok.ok, true);
  assert.deepEqual(store.items[0].ticketIds, ['t-mwtest01-abcd']);
  assert.equal(store.items[0].title, '老工单', '其余字段原样保留');
  const missing = await pool.attachTicket({ backlogId: 'bl-mwabc-2', ticketId: 't-mwtest01-abcd' });
  assert.equal(missing.ok, false);
  assert.equal(store.items.length, 1, '认不出工单就不新建');
});

test('backlogIdInGoal：solution 动机的 goal 里认得出工单号', () => {
  assert.equal(backlogIdInGoal('执行已定方案 bl-mwou8aie-a67a：做第一步'), 'bl-mwou8aie-a67a');
  assert.equal(backlogIdInGoal('跟工单无关的一句话'), '');
  assert.equal(backlogIdInGoal(''), '');
});

/* ── 每夜上限 / 汇总 ───────────────────────────────────── */

test('夜账期：跨午夜算同一夜，0 点不重开计数', () => {
  assert.equal(nightKeyOf(at(2026, 11, 21, 23, 45), cfg), '2026-11-21', '进窗口那晚');
  assert.equal(nightKeyOf(at(2026, 11, 22, 0, 5), cfg), '2026-11-21', '过了 0 点还记在前一天头上');
  assert.equal(nightKeyOf(at(2026, 11, 22, 7, 59), cfg), '2026-11-21');
  assert.equal(nightKeyOf(at(2026, 11, 22, 8, 30), cfg), '2026-11-22', '天亮之后是新的一天');
  assert.equal(nightKeyOf(at(2026, 11, 22, 3, 0), { quietStart: 8, quietEnd: 23.66 }), '2026-11-22', '不跨午夜的窗口就按日历日');
});

test('每夜上限：0 = 不限（当前口径），正数才拦', () => {
  assert.equal(limitReached(999, 0), false, '0 不限');
  assert.equal(limitReached(999, undefined), false, '没配也不限');
  assert.equal(limitReached(0, 3), false);
  assert.equal(limitReached(2, 3), false);
  assert.equal(limitReached(3, 3), true);
});

test('汇总：空账不拼消息，有账只拼一条并带条数', () => {
  assert.equal(buildDigestText({ entries: [], tickets: 0, inbox: 0 }), '');
  const text = buildDigestText({
    entries: [
      { kind: 'ask', title: '要不要开夜间' },
      { kind: 'ask', title: '要不要关夜间' },
      { kind: 'do', callId: 'c1', title: '改一行配置' },
    ],
    tickets: 1,
  });
  assert.equal(text.split('\n').length, 1, '就是一条');
  assert.match(text, /记了 2 条待你定/);
  assert.match(text, /昨夜攒了 1 张待开票的活/);
  assert.match(text, /还有 1 张开票申请没递出去/);
});

test('汇总：去重命中的那条不算进「待你定」条数', () => {
  const text = buildDigestText({
    entries: [{ kind: 'ask', title: '同一条' }, { kind: 'ask-duplicate', title: '同一条' }],
  });
  assert.match(text, /记了 1 条待你定/);
});

test('汇总：写池失败的那几条要说出「记在本地收件箱」', () => {
  const text = buildDigestText({ entries: [{ kind: 'ask-failed', title: 'x' }], inbox: 2 });
  assert.match(text, /没写进工单池/);
});

test('汇总：超长截断，不发一屏', () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({ kind: 'ask', title: `第 ${index} 条很长的待定事项标题` }));
  const text = buildDigestText({ entries, tickets: 0, maxChars: 80 });
  assert.ok([...text].length <= 80);
});
