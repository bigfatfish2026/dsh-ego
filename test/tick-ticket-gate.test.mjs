/**
 * tick 层的票台闸。
 *
 * 断言的是「这一拍到底跑没跑」：票台有票就一次提议都不许发；空票才走掷骰 → 提议；
 * 查不到票台按不空跳过；开关关掉照跑；手动催拍不经过这道闸。
 * 提议器/裁决器都是假实现，不碰模型、不碰宿主。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoundEngine } from '../lib/engines/round.js';

const NOW = Date.parse('2026-11-14T20:00:00+08:00'); // 周六 20:00，谷价时段

function makeRig({ cfg: cfgOverrides = {}, probe = { busy: false, count: 0, source: 'service' }, noProbe = false, ctx = {} } = {}) {
  const logs = [];
  const saves = [];
  const calls = { propose: 0, probe: 0 };
  const cfg = {
    enabled: true,
    dryRun: true,
    skipWhenTicketsBusy: true,
    tickIntervalMinutes: 60,
    diceProbability: 1,
    delayMaxMinutes: 8,
    quietStart: 23.66,
    quietEnd: 8,
    offPeakOnly: true,
    holidays: [],
    privateOnly: false,
    targetSession: 'c2c:test',
    maxFailStreak: 3,
    backoffMinutes: 60,
    pendingTtlMinutes: 30,
    forceTriggerPath: '/tmp/dsh-ego-force',
    proposer: { enabled: true },
    judge: { enabled: true },
    ...cfgOverrides,
  };
  const state = {
    nextRunAt: NOW - 1000,
    retryAfterAt: 0,
    failStreak: 0,
    busySkips: 0,
    lastRunAt: 0,
    lastRollAt: 0,
    targetSession: '',
    pendingSayQueue: [],
    pendingTicketQueue: [],
    pendingSeq: 0,
    ticketRequests: [],
  };

  const ticketProbe = noProbe
    ? undefined
    : async () => {
        calls.probe += 1;
        if (probe instanceof Error) throw probe;
        return probe;
      };

  const round = createRoundEngine({
    cfg,
    state,
    save: () => saves.push(state.nextRunAt),
    log: (line) => logs.push(line),
    gate: {},
    ctx,
    proposer: {
      async propose() {
        calls.propose += 1;
        return { ok: true, idea: '', why: '这一拍没想法', stage1Empty: true, rewrites: 0 };
      },
    },
    adjudicator: { getVetoLedger() {} },
    scopeOf: () => 'c2c',
    fmt: (t) => String(t),
    ...(noProbe ? {} : { ticketProbe }),
  });

  return { round, cfg, state, logs, saves, calls };
}

test('票台有未终态票：这一拍直接轮空，不提议、记计数、日志固定文案', async () => {
  const rig = makeRig({ probe: { busy: true, count: 2, source: 'service', detail: 'service=2／sqlite=2' } });
  await rig.round.tick(NOW);

  assert.equal(rig.calls.propose, 0, '有票时一次提议都不许发');
  assert.equal(rig.state.busySkips, 1);
  assert.ok(rig.logs.some((line) => line === '[ego] 轮空：票台有 2 张未终态票（open/running/waiting/blocked）'));
  assert.ok(
    rig.logs.some((line) => line === '[ego] 票台探针 source=service count=2 busy=1（service=2／sqlite=2）'),
    '轮空那拍也要留探针来源行',
  );
  assert.ok(rig.state.nextRunAt > NOW, '轮空也要把下一拍排上，不能停摆');
  assert.equal(rig.state.lastRunAt, 0, '没掷骰就不刷 lastRunAt');
  assert.equal(rig.state.lastRollAt, 0);
});

test('票台空：正常掷骰并走提议（轮空计数不动，探针来源照样留痕）', async () => {
  const rig = makeRig({ probe: { busy: false, count: 0, source: 'sqlite', detail: 'service 没拿到／sqlite=0' } });
  await rig.round.tick(NOW);

  assert.equal(rig.calls.propose, 1);
  assert.equal(rig.calls.probe, 1);
  assert.equal(rig.state.busySkips, 0);
  assert.equal(rig.state.lastRollAt, NOW);
  assert.ok(
    rig.logs.some((line) => line.startsWith('[ego] 票台探针 source=sqlite count=0 busy=0')),
    '空拍也要说清走的哪条路、读到几个',
  );
});

test('查不到票台：按不空跳过，日志带原因', async () => {
  const rig = makeRig({
    probe: {
      busy: true,
      unknown: true,
      count: 0,
      source: 'none',
      error: '读库也失败：CANTOPEN',
      detail: 'service 没拿到：没有 dispatcher/tickets 服务／sqlite 没拿到：CANTOPEN',
    },
  });
  await rig.round.tick(NOW);

  assert.equal(rig.calls.propose, 0);
  assert.equal(rig.state.busySkips, 1);
  assert.ok(rig.logs.some((line) => line === '[ego] 轮空：票台查不到（读库也失败：CANTOPEN），按不空处理'));
  assert.ok(
    rig.logs.some((line) => line.startsWith('[ego] 票台探针 source=none count=0 busy=1')),
    '查不到那拍也要留探针来源行',
  );
});

test('探针自己抛错：也按不空跳过，别把这一拍放过去', async () => {
  const rig = makeRig({ probe: new Error('探针炸了') });
  await rig.round.tick(NOW);

  assert.equal(rig.calls.propose, 0);
  assert.equal(rig.state.busySkips, 1);
  assert.ok(rig.logs.some((line) => line.startsWith('[ego] 轮空：票台查不到（') && line.includes('探针炸了')));
  assert.ok(
    rig.logs.some((line) => line.startsWith('[ego] 票台探针 source=none count=0 busy=1') && line.includes('探针炸了')),
    '抛错也留一行，别让这一拍变成无痕迹放行',
  );
});

test('skipWhenTicketsBusy=false：有票也照跑，而且根本不探票台', async () => {
  const rig = makeRig({
    cfg: { skipWhenTicketsBusy: false },
    probe: { busy: true, count: 5, source: 'service' },
  });
  await rig.round.tick(NOW);

  assert.equal(rig.calls.probe, 0);
  assert.equal(rig.calls.propose, 1);
  assert.equal(rig.state.busySkips, 0);
});

test('票台空时拍内随机闸仍然生效：命中线 0 就不提议', async () => {
  const rig = makeRig({ cfg: { diceProbability: 0 }, probe: { busy: false, count: 0 } });
  await rig.round.tick(NOW);

  assert.equal(rig.calls.probe, 1, '票台还是查了');
  assert.equal(rig.calls.propose, 0, '骰子没中就不该生成想法');
  assert.equal(rig.state.busySkips, 0);
  assert.equal(rig.state.lastRollAt, NOW, '骰确实掷了');
});

test('手动催拍不过票台闸：ego_tick / touch force 照旧跑一拍', async () => {
  const rig = makeRig({ probe: { busy: true, count: 3, source: 'service' } });
  const result = await rig.round.manualTick(NOW);

  assert.equal(result.ok, true);
  assert.equal(rig.calls.probe, 0, '手动拍不探票台');
  assert.equal(rig.calls.propose, 1);
  assert.equal(rig.state.busySkips, 0);
  assert.equal(rig.state.nextRunAt, NOW - 1000, '手动拍不动正常排期');
});

test('没有注入探针：不过闸（单测/老调用兼容，线上由 index.js 注入）', async () => {
  const rig = makeRig({ noProbe: true });
  await rig.round.tick(NOW);

  assert.equal(rig.calls.propose, 1);
  assert.equal(rig.state.busySkips, 0);
});

/*
 * 补发不过闸：retryPending 跑在票台闸之前，且故意不查闸。
 * 队列里的条目是上一拍 judge 已经裁成 ask/do 的产物，补发只负责投递，不重新提议、
 * 不重新裁决，所以「现在票台忙」跟它无关。反着改会让已批的事被 pendingTtl 吞掉。
 * 这条用例把语义钉死：同一拍里补发照发，闸照样轮空。
 */
test('票台忙时补发照发（补发=执行已批准的事，不过闸），同拍仍然轮空', async () => {
  const sent = [];
  const rig = makeRig({
    cfg: { dryRun: false },
    probe: { busy: true, count: 3, source: 'service' },
    ctx: {
      agents: {
        get: () => ({
          status: 'idle',
          session: 's1',
          async followup(message) {
            sent.push(message.content[0].text);
          },
        }),
      },
    },
  });
  // 上一拍已经裁成 ask、只是没发出去的那一句
  rig.state.pendingSayQueue.push({ id: 'p1', at: NOW - 60_000, text: '上一拍已经批过的那句' });
  rig.state.targetSession = 'c2c:test';

  await rig.round.tick(NOW);

  assert.equal(sent.length, 1, '票台忙不挡补发：已批的那句照发');
  assert.match(sent[0], /上一拍已经批过的那句/);
  assert.equal(rig.state.pendingSayQueue.length, 0, '发出去了就 ack 掉');
  assert.equal(rig.calls.propose, 0, '同一拍照样被闸挡掉，不提议');
  assert.equal(rig.state.busySkips, 1);
  assert.ok(
    rig.logs.some((line) => line === '[ego] 轮空：票台有 3 张未终态票（open/running/waiting/blocked）'),
    '闸的日志照旧',
  );
});
