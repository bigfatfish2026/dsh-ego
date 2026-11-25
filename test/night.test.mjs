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
import { createRoundEngine } from '../lib/engines/round.js';
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
  trimJournal,
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

test('汇总：撞到每夜上限的条目也要报出来（池里/队列里都没有，只报日志等于没说）', () => {
  const text = buildDigestText({
    entries: [
      { kind: 'do', callId: 'c1', title: '改一行配置' },
      { kind: 'do-skipped', title: '第二条被跳过的活' },
      { kind: 'do-skipped', title: '第三条被跳过的活' },
      { kind: 'ask-skipped', title: '被跳过的待定' },
    ],
    tickets: 1,
  });
  assert.match(text, /另有 待你定 1 条、待开票 2 张 撞到每夜上限/);
  // 只有「跳过」也要发：否则主人以为这一夜什么都没发生
  const onlySkipped = buildDigestText({ entries: [{ kind: 'do-skipped', title: 'x' }] });
  assert.notEqual(onlySkipped, '');
  assert.match(onlySkipped, /待开票 1 张/);
});

test('trimJournal：超上限只丢最旧的那几条，返回丢掉的数量', () => {
  const list = [1, 2, 3, 4].map((n) => ({ n }));
  assert.equal(trimJournal(list, 10), 0, '没超不动');
  assert.equal(list.length, 4);
  assert.equal(trimJournal(list, 2), 2, '丢掉 2 条');
  assert.deepEqual(list.map((one) => one.n), [3, 4], '留下的是最新的');
});

/* ── 引擎级：夜间队列的计数与账本 ─────────────────────────── */

/** 按 tick-ticket-gate.test.mjs 同一个 rig 形状搭一个最小引擎（不碰模型/宿主） */
function makeNightRig({ cfg: cfgOverrides = {} } = {}) {
  const logs = [];
  const state = {
    nextRunAt: 0,
    retryAfterAt: 0,
    failStreak: 0,
    pendingSayQueue: [],
    pendingTicketQueue: [],
    pendingNightTicketQueue: [],
    pendingSeq: 0,
    ticketRequests: [],
    ticketSeq: 0,
    nightJournal: [],
    nightAskCount: 0,
    nightDoCount: 0,
  };
  const cfg = {
    enabled: true,
    dryRun: true,
    skipWhenTicketsBusy: false,
    tickIntervalMinutes: 60,
    diceProbability: 1,
    delayMaxMinutes: 8,
    quietStart: 23.66,
    quietEnd: 8,
    offPeakOnly: true,
    holidays: [],
    privateOnly: false,
    targetSession: '',
    maxFailStreak: 3,
    backoffMinutes: 60,
    pendingTtlMinutes: 30,
    nightMode: true,
    nightMaxDo: 2,
    nightMaxAsk: 2,
    nightDigest: true,
    proposer: { enabled: true },
    judge: { enabled: true },
    ...cfgOverrides,
  };
  /*
   * 夜间 ask 会经 createNightPool 落工单池。不注入 openStore 时它落的是真库
   * ~/.dsh/backlog/backlog.db——单测往里写一条假「[夜]」条目，主人翻池子就会看到。
   * 这里统一注入内存假存储，测试一个字节都不落盘。
   */
  const store = fakeStore();
  const round = createRoundEngine({
    cfg,
    state,
    save: () => {},
    log: (line) => logs.push(line),
    gate: {},
    ctx: {},
    proposer: { async propose() {} },
    adjudicator: { getVetoLedger() {} },
    scopeOf: () => 'c2c',
    fmt: (t) => String(t),
    openNightStore: async () => store,
  });
  return { round, state, cfg, logs, store };
}

test('夜间 do：同一条活重判一次不重复入队，也不白吃一张每夜上限', async () => {
  const { round, state, logs } = makeNightRig();
  const ticket = { goal: '在 /tmp/x.md 补一行说明', brief: '补一行说明' };
  const first = await round.queueNightTicket(ticket, 1000);
  assert.equal(first.ok, true);
  assert.equal(state.nightDoCount, 1, '第一次真入队，计数 +1');
  assert.equal(state.pendingNightTicketQueue.length, 1);

  const again = await round.queueNightTicket(ticket, 2000);
  assert.equal(again.duplicate, true, '同 callId 第二次是 duplicate');
  assert.equal(state.nightDoCount, 1, '重复入队不加计数（以前会白吃一张额度）');
  assert.equal(state.pendingNightTicketQueue.length, 1, '队列里还是一条');
  assert.equal(state.nightJournal.filter((one) => one.kind === 'do').length, 1, '账本里只记一笔真 do');
  assert.ok(logs.some((line) => line.startsWith('night_do_duplicate:')), '重复要留痕');
});

test('夜间 do：到上限的条目不进队列，但账本留一笔 do-skipped，日志带票面', async () => {
  const { round, state, logs } = makeNightRig({ cfg: { nightMaxDo: 1 } });
  await round.queueNightTicket({ goal: '第一件 /tmp/a', brief: '第一件' }, 1000);
  const blocked = await round.queueNightTicket({ goal: '第二件 /tmp/b', brief: '第二件' }, 2000);
  // 到上限是「按配置收手」，不是失败拍：返 ok:false 会涨 failStreak，三拍就连着退避一小时
  assert.equal(blocked.ok, true);
  assert.equal(blocked.skipped, true);
  assert.equal(state.pendingNightTicketQueue.length, 1, '被跳过的不进队列');
  assert.equal(state.nightJournal.filter((one) => one.kind === 'do-skipped').length, 1, '账本里要留一笔');
  const line = logs.find((one) => one.startsWith('night_do_skipped:limit'));
  assert.ok(line, '日志要留');
  assert.match(line, /第二件/, '日志里要能看出被丢的是哪一条');
});

test('夜间 ask：到上限的条目不写池，但账本留一笔 ask-skipped', async () => {
  const { round, state, logs } = makeNightRig({ cfg: { nightMaxAsk: 0 } });
  // 上限 0 = 不限，先验不拦
  const unlimited = await round.nightAsk('不限的一条', 1000, { idea: '点子' });
  assert.equal(unlimited.ok, true);

  const capped = makeNightRig({ cfg: { nightMaxAsk: 1 } });
  capped.state.nightAskCount = 1; // 这一夜已经记过一条
  const blocked = await capped.round.nightAsk('第二条要不要开', 2000, { idea: '点子二' });
  assert.equal(blocked.ok, true, '到上限不算失败拍');
  assert.equal(blocked.skipped, true);
  assert.equal(capped.state.nightJournal.filter((one) => one.kind === 'ask-skipped').length, 1);
  assert.ok(capped.logs.some((line) => line.startsWith('night_ask_skipped:limit') && /第二条要不要开/.test(line)));
});

test('早上汇总：真 do 与被跳过的 do 分开报，跳过的那几条不会凭空消失', async () => {
  const { round, state } = makeNightRig({ cfg: { nightMaxDo: 1 } });
  await round.queueNightTicket({ goal: '第一件 /tmp/a', brief: '第一件' }, 1000);
  await round.queueNightTicket({ goal: '第二件 /tmp/b', brief: '第二件' }, 2000);
  const text = buildDigestText({
    entries: state.nightJournal,
    tickets: state.pendingNightTicketQueue.length,
  });
  assert.match(text, /昨夜攒了 1 张待开票的活/, '真攒下的那张照旧报');
  assert.match(text, /另有 待开票 1 张 撞到每夜上限/, '被跳过的要单独说一句');
});

test('连撞三拍每夜上限也不许退避：到上限是配置收手，不是这一拍坏了', async () => {
  const { round, state } = makeNightRig({ cfg: { nightMaxDo: 1 } });
  await round.queueNightTicket({ goal: '第一件 /tmp/a', brief: '第一件' }, 1000);
  for (let index = 0; index < 3; index += 1) {
    const blocked = await round.queueNightTicket({ goal: `撞上限的第 ${index} 件 /tmp/x${index}`, brief: `第 ${index} 件` }, 2000 + index);
    assert.equal(blocked.ok, true, '每次都要当成功拍');
    assert.equal(blocked.skipped, true);
  }
  assert.equal(state.failStreak, 0, 'failStreak 一下都不许涨');
  assert.equal(state.retryAfterAt, 0, '不许把整夜退避掉');
  assert.equal(
    state.nightJournal.filter((one) => one.kind === 'do-skipped').length,
    3,
    '跳过三拍就记三笔，跟日志对得上',
  );
});

test('夜间 ask 走注入的假存储，不碰真工单池库', async () => {
  const { round, store, state } = makeNightRig();
  const written = await round.nightAsk('这条只该进假池子', 5000, { idea: '点子', why: '理由', reason: '裁决' });
  assert.equal(written.ok, true);
  assert.equal(store.items.length, 1, '假存储里正好一条');
  assert.match(store.items[0].title, /^\[夜\] /);
  assert.match(store.items[0].note, /来源=ego夜间/);
  assert.equal(state.nightAskCount, 1);
  // 同一句再来一次：假存储按去重标记认重复，不写第二条
  const again = await round.nightAsk('这条只该进假池子', 6000, { idea: '点子', why: '理由', reason: '裁决' });
  assert.equal(again.duplicate, true);
  assert.equal(store.items.length, 1, '不是 2 条');
});
