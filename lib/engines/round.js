/**
 * 一拍引擎：ask / 开票 / 否决后的 runRound / pending 补发 / tick / 手动催拍。
 *
 * 从 lib/index.js 的 apply 闭包里整段搬出来（行为零改动）。闭包里的可变状态
 * （dryRunOverride、retryingPending、ticking）收成这个对象自己的字段；
 * 目标会话解析、活表查找、消息包装原本也在 apply 里，一并搬来。
 */
import { randomUUID } from 'node:crypto';
import { ackPending, ackPendingByKey, enqueuePending, pendingCount, pendingHead } from '../pending-queue.js';
import { createTicketOpener, normalizeTicket, routeDecision, ticketCallId } from '../route.js';
import { createManualTick } from '../ego-tick.js';
import { isDirectScope } from '../scope.js';
import { clampAskText } from '../gate.js';
import { delayMs, hit, inNight, rollDice, speakingWindow } from '../window.js';
import { prunePending, recordFailure, recordSuccess } from '../state.js';
import { formatBusyLog, formatProbeLog, formatUnknownLog } from '../ticket-gate.js';
import {
  JOURNAL_LIMIT,
  NIGHT_QUEUE,
  backlogIdInGoal,
  buildAskRow,
  buildDigestText,
  canDrainNight,
  clip as nightClip,
  createNightPool,
  findNightTicketByContent,
  limitReached,
  nightKeyOf,
  oneLine as nightOneLine,
  trimJournal,
} from '../night.js';

/** 把它自己的念头包一层，免得模型把它当成「对方发来的消息」去回答 */
function frame(text) {
  return [
    '（下面这句是你自己心里冒出来的念头，不是对方发来的消息，不用回应它，顺着它去做就行。）',
    '（这是你自己开的一轮：跟用户说一句，短，一两句就好；别说「我来汇报」这种，也别列清单。）',
    String(text ?? '').trim(),
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.cfg 已合并默认值、已夹过预算的配置
 * @param {object} deps.state 插件内存 state
 * @param {Function} deps.save 落盘 state
 * @param {Function} deps.log 单行日志
 * @param {object} deps.gate 校验层实例
 * @param {object} deps.ctx 宿主 ctx
 * @param {object} deps.proposer 提议器实例
 * @param {object} deps.adjudicator 裁决器实例
 * @param {Function} deps.scopeOf 会话 → 群聊/私聊
 * @param {Function} deps.fmt 时间格式化
 * @param {Function} [deps.ticketProbe] 票台探针：返回 {busy, count, unknown?, error?}；
 *   不传就不过票台闸（单测用），线上由 index.js 注入
 */
export function createRoundEngine(deps) {
  const { cfg, state, save, log, gate, ctx, proposer, adjudicator, scopeOf, fmt, ticketProbe } = deps;

  /*
   * 演练开关的本次调用覆盖：ego_tick 传 dryRun=true/false 时只在这一拍内生效，
   * 跑完恢复 null（= 沿用配置）。ask 和开票申请都读这个函数，避免为了一个参数
   * 去改 cfg（主会话并发读状态时看到假的 dryRun）。
   */
  let dryRunOverride = null;
  const activeDryRun = () => (dryRunOverride === null ? Boolean(cfg.dryRun) : Boolean(dryRunOverride));

  /** 目标会话：配置里写死的优先，否则用学到的 */
  function targetId() {
    return String(cfg.targetSession || state.targetSession || '').trim();
  }

  function findAgent(id) {
    if (!id) return undefined;
    const candidates = [id];
    if (id.startsWith('session-')) candidates.push(id.slice('session-'.length));
    else candidates.push(`session-${id}`);
    for (const one of candidates) {
      try {
        const agent = ctx.agents.get(one);
        if (agent !== undefined) return agent;
      } catch {
        /* agents 服务查不动：当作没找到 */
      }
    }
    return undefined;
  }

  function buildMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-ego' },
    };
  }

  /**
   * 发不出去也先记着：下次这一拍再试，TTL 过了就丢（at 不刷新，才是真的 TTL）。
   * 队列按产生时间有序，同一句重复入队只保留最先那条（沿用原 at），后到的不覆盖前面的别的句子。
   */
  function rememberSay(text, at) {
    enqueuePending(state, 'say', { text, at }, { log });
    save();
  }

  // ── ask 分支：跟用户说一句（followup 主会话） ─────────────────
  async function ask(text, nowMs, { quiet = false } = {}) {
    if (activeDryRun()) {
      log(`[dry] 本来要跟用户说：${text}`);
      state.lastAction = 'ask';
      return { ok: true, dry: true };
    }
    const id = targetId();
    if (!id) {
      rememberSay(text, nowMs);
      if (!quiet) log('还不知道跟哪个会话说话（等用户在私聊里说一句），先存着');
      return { ok: false, pending: true, detail: '没有目标会话' };
    }
    if (cfg.privateOnly && id !== cfg.targetSession && !isDirectScope(scopeOf(id))) {
      log(`会话 ${id.slice(-8)} 不是私聊，这个念头丢掉`);
      return { ok: false, detail: '目标不是私聊' };
    }
    const agent = findAgent(id);
    if (!agent) {
      rememberSay(text, nowMs);
      if (!quiet) log(`会话 ${id.slice(-8)} 不在活表（没找到活着的 agent），先存着`);
      return { ok: false, pending: true, detail: '会话不在活表' };
    }
    if (agent.status !== undefined && agent.status !== 'idle') {
      rememberSay(text, nowMs);
      if (!quiet) log(`会话 ${id.slice(-8)} 正忙（${agent.status}），先存着`);
      return { ok: false, pending: true, detail: '会话正忙' };
    }
    try {
      await agent.followup(buildMessage(frame(text)));
    } catch (error) {
      const detail = `followup 失败：${String(error?.message ?? error)}`;
      log(detail);
      return { ok: false, detail };
    }
    state.lastSpokeAt = nowMs;
    state.lastAskAt = nowMs;
    state.lastReportAt = nowMs;
    // 出队确认：这句真发出去了才销账（只销同文本那条，队列里别的话不动）
    ackPendingByKey(state, 'say', { text });
    save();
    try {
      if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session);
    } catch {
      /* 落盘确认失败无所谓 */
    }
    log(`已在 ${id.slice(-8)} 跟用户说：${text}`);
    return { ok: true };
  }

  // ── do 分支：向主会话提开票申请（执行体在 lib/route.js，这里只接线） ────
  const openTicketRaw = createTicketOpener({
    findAgent,
    targetId,
    state,
    save,
    flush: async (agent) => {
      if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session);
    },
    log,
    // 传函数而不是快照：ego_tick 的 dryRun 参数要在这一拍内即时生效
    dryRun: activeDryRun,
    openTimeoutMs: cfg.openTimeoutMs,
  });

  async function openTicket(ticket, nowMs, options) {
    const opened = await openTicketRaw(ticket, nowMs, options);
    // duplicate = 同一 callId 已经提过，不算新动作，别把 lastReportAt 又刷一遍
    if (opened.ok && !opened.duplicate) {
      state.lastAction = 'do';
      state.lastReportAt = nowMs;
      save();
    }
    return opened;
  }

  // ── 夜间分支：ask 落工单池、do 进不过期队列（实现在 lib/night.js） ──────
  const nightPool = createNightPool({ log });

  /** 夜间账本：只给早上的汇总用，超上限丢最旧的；跟着 state 落盘 */
  function nightJournal() {
    if (!Array.isArray(state.nightJournal)) state.nightJournal = [];
    return state.nightJournal;
  }

  function rememberNight(entry) {
    const journal = nightJournal();
    journal.push(entry);
    const dropped = trimJournal(journal, JOURNAL_LIMIT);
    if (dropped > 0) log(`night_ledger_trim｜夜间账本超过 ${JOURNAL_LIMIT} 条，挤掉最旧的 ${dropped} 条`);
  }

  /** 换夜第一拍：把「每夜几条」的计数清零，并记下这一夜是哪天 */
  function rollNightCounters(nowMs) {
    const day = nightKeyOf(new Date(nowMs), cfg);
    if (String(state.nightFor ?? '') === day) return;
    state.nightFor = day;
    state.nightAskCount = 0;
    state.nightDoCount = 0;
    save();
  }

  /**
   * 夜里的 ask：不进 followup（人在睡，没人接），直接写进工单池一条待办。
   * 写池失败退化成 state.nightInbox（第二天的汇总里带一句），绝不让夜间拍崩掉。
   */
  async function nightAsk(text, nowMs, { idea = '', why = '', reason = '' } = {}) {
    const used = Number(state.nightAskCount) || 0;
    if (limitReached(used, cfg.nightMaxAsk)) {
      /*
       * 到上限：不入池，但账本上要留一笔（kind=ask-skipped），
       * 否则早上的汇总只报池里那几条，主人看不到「还丢掉了几条」。
       */
      rememberNight({ kind: 'ask-skipped', title: nightClip(text || idea, 40), at: nowMs });
      save();
      log(`night_ask_skipped:limit｜这一夜已经记了 ${used} 条（上限 ${cfg.nightMaxAsk}）｜${nightClip(text || idea, 60)}`);
      /*
       * 返 ok:true：到上限是「按配置收手」，不是这一拍坏了。返 false 会涨 failStreak，
       * 连着三拍撞上限就退避一小时——把整个夜间模式停掉，比丢几条待定糟得多。
       * 跟上面写池失败那条同一个口径（见 night_ask_failed 那段注释）。
       */
      return { ok: true, skipped: true, detail: '夜间 ask 到上限了' };
    }
    const row = buildAskRow({ text, idea, why, reason, now: nowMs });
    const written = await nightPool.putAsk(row);
    state.nightAskCount = used + 1;
    if (written.ok) {
      rememberNight({ kind: written.duplicate ? 'ask-duplicate' : 'ask', title: row.title, hash: row.hash, at: nowMs });
      state.lastAction = 'ask';
      state.lastReason = `夜间入池：${nightClip(row.title, 120)}`;
      save();
      log(`night_ask:${written.duplicate ? 'duplicate' : 'pooled'}｜${row.title}｜backlog:${written.id || '-'}`);
      return { ok: true, id: written.id, duplicate: Boolean(written.duplicate) };
    }
    if (!Array.isArray(state.nightInbox)) state.nightInbox = [];
    state.nightInbox.push({ text, idea, why, reason, at: nowMs, error: String(written.error ?? '') });
    while (state.nightInbox.length > 50) state.nightInbox.shift();
    rememberNight({ kind: 'ask-failed', title: row.title, at: nowMs, error: String(written.error ?? '') });
    state.lastAction = 'ask';
    state.lastReason = `夜间入池失败：${nightClip(written.error, 120)}`;
    save();
    log(`night_ask_failed:${nightClip(written.error, 160)}｜已记进 state.nightInbox`);
    /*
     * 这不算「这一拍失败」：话已经落在 state.nightInbox 里，早上的汇总会带一句。
     * 返 ok:false 会让连败计数涨上去、三拍后就退避一小时——
     * 工单池一时打不开不该让整个夜间模式停摆。
     */
    return { ok: true, inbox: true, detail: written.error };
  }

  /**
   * 夜里的 do：不进 30 分钟 TTL 的 pendingTicketQueue，进 nightTicket（不过期）。
   * 早上窗口恢复、主会话 idle 时由 drainNightTickets 按顺序提出去。
   */
  async function queueNightTicket(ticket, nowMs, { reason = '' } = {}) {
    const normalized = normalizeTicket(ticket);
    if (!normalized) return { ok: false, detail: '终审给的 goal 是空的' };
    const used = Number(state.nightDoCount) || 0;
    if (limitReached(used, cfg.nightMaxDo)) {
      // 同 ask：到上限不进队列，但账本上留一笔，汇总里要说得出来
      rememberNight({ kind: 'do-skipped', title: nightClip(normalized.brief, 40), at: nowMs });
      save();
      log(`night_do_skipped:limit｜这一夜已经攒了 ${used} 张（上限 ${cfg.nightMaxDo}）｜票面:${nightClip(normalized.brief, 60)}`);
      // 同 ask：到上限是配置收手，不算失败拍（否则三拍连撞就退避一小时，整夜停摆）
      return { ok: true, skipped: true, detail: '夜间 do 到上限了' };
    }
    /*
     * callId 先看夜间队列里有没有同一份活：ticketCallId 只查白天队列和 ticketRequests，
     * 查不到就会新发一个序号，同一份活在夜间队列里排成两条（各吃一张额度、早上推两遍）。
     * 沿用原 callId 后 enqueuePending 按 callId 去重，下面就能按 duplicate 走。
     */
    const prev = findNightTicketByContent(state, normalized);
    const callId = prev?.callId ? String(prev.callId) : ticketCallId(state, nowMs, normalized);
    /*
     * 同 callId 已经在队列里时 enqueuePending 会返回 duplicate 且什么都不写。
     * 那种情况下不能加计数、也不能记台账：否则同一条活重判一次就白吃一张
     * 每夜额度，账本还会多出一笔并不存在的新 do（早上的汇总条数会虚高）。
     */
    const queued = enqueuePending(state, NIGHT_QUEUE, { ...normalized, callId, reason, at: nowMs }, { log });
    if (queued.duplicate) {
      log(`night_do_duplicate:${callId}｜队列里已有这一条，不重复入队、不计入每夜上限｜票面:${nightClip(normalized.brief, 60)}`);
      return { ok: true, queued: true, duplicate: true, callId };
    }
    state.nightDoCount = used + 1;
    state.lastAction = 'do';
    state.lastReason = `夜间入队：${nightClip(normalized.brief, 120)}`;
    rememberNight({ kind: 'do', callId, title: normalized.brief, at: nowMs });
    save();
    log(`night_do_queued:${callId}｜票面:${nightClip(normalized.brief, 60)}｜队列里 ${pendingCount(state, NIGHT_QUEUE)} 张`);
    return { ok: true, queued: true, callId };
  }

  /**
   * 早上把夜里的开票申请逐条提上去（一次只提队头那张）。
   *
   * 三个条件缺一不可：窗口恢复（不在安静/峰价）、主会话在活表、主会话 idle。
   * 少任何一条就只等——不能在主会话还没起来时提：openTicket 在查不到 agent 时
   * 会把条目塞进 30 分钟 TTL 的 pendingTicketQueue（route.js:211-221），
   * 那等于把夜里的活绕一圈又丢一次。
   */
  async function drainNightTickets(nowMs) {
    if (pendingCount(state, NIGHT_QUEUE) === 0) return { drained: 0 };
    const window = speakingWindow(new Date(nowMs), cfg);
    // 夜里本来就提不出去，安安静静压着，别每拍刷一行 wait
    if (!window.ok && inNight(new Date(nowMs), cfg)) return { waiting: true };
    const agent = findAgent(targetId());
    if (!canDrainNight({ windowOk: window.ok, agent })) {
      log(
        `night_do_wait:${window.ok ? '主会话未就绪' : window.reason}`
          + `｜队列里 ${pendingCount(state, NIGHT_QUEUE)} 张，等条件齐了再提`,
      );
      return { waiting: true };
    }
    const ticket = pendingHead(state, NIGHT_QUEUE);
    if (!ticket) return { drained: 0 };
    // callId 沿用夜里入队时那个：否则这里会再发一个序号，台账和申请正文对不上
    const opened = await openTicket(ticket, nowMs, { quiet: true, reason: ticket.reason, callId: ticket.callId });
    if (opened.ok && !opened.pending) {
      ackPending(state, NIGHT_QUEUE, ticket.id);
      // 主会话真接了：把 callId 记进台账；能拿到真票号就把票号回填到来源工单
      if (!Array.isArray(state.nightTickets)) state.nightTickets = [];
      const ticketId = String(opened.ticketId ?? opened.ticket?.id ?? '').trim();
      state.nightTickets.push({ callId: ticket.callId, goal: ticket.goal, brief: ticket.brief, ticketId, at: nowMs });
      // 台账满了挤掉最旧的那条：不声不响地丢，事后对不上账，所以丢几条记几行
      const droppedTickets = trimJournal(state.nightTickets, 50);
      if (droppedTickets > 0) log(`night_ledger_trim｜夜里开票台账超过 50 条，挤掉最旧的 ${droppedTickets} 条`);
      save();
      if (ticketId) {
        const backlogId = backlogIdInGoal(ticket.goal);
        const attached = await nightPool.attachTicket({ backlogId, ticketId });
        log(
          `night_do_sent:${ticket.callId}｜票号 ${ticketId}`
            + (attached.ok ? `｜已回填工单 ${backlogId}` : `｜回填跳过：${attached.error || '没有对应工单'}`),
        );
      } else {
        log(`night_do_sent:${ticket.callId}｜票号还没回来，等主会话开完票再回填`);
      }
      return { drained: 1 };
    }
    if (opened.ok && opened.pending) {
      /*
       * 递出去的瞬间主会话又忙了：这一条被 route 塞进了白天那个 30 分钟队列。
       * 立刻把它从白天队列摘掉，只留夜里的这份（否则会两头各提一次）。
       */
      const dropped = ackPendingByKey(state, 'ticket', { callId: ticket.callId });
      save();
      log(`night_do_retry:${ticket.callId}｜主会话刚忙起来，摘掉白天队列 ${dropped} 条，夜里这条保留`);
      return { waiting: true };
    }
    log(`night_do_fail:${ticket.callId}｜${nightClip(opened.detail || opened.error || '递不出去', 160)}`);
    return { failed: true };
  }

  /**
   * 早上的那条汇总：一夜只发一条 followup，不逐条播报。
   * 走现成的 ask()（privateOnly / 目标会话 / pending 全都照旧）；
   * 发不出去就留着，下一拍窗口还开着时再试，发出去才在账本上盖 digestAt。
   */
  async function sendNightDigest(nowMs, { sentSayText = '' } = {}) {
    if (!cfg.nightDigest) return { skipped: true };
    const journal = nightJournal().filter((entry) => !entry.digestAt);
    if (journal.length === 0 && pendingCount(state, NIGHT_QUEUE) === 0) return { skipped: true };
    const window = speakingWindow(new Date(nowMs), cfg);
    if (!window.ok) return { waiting: true };
    /*
     * 汇总文案要稳定：没发出去之前每一拍重拼，条目一多就会拼出另一段话，
     * 队列里于是躺着两条意思不同的汇总（自己踩过）。所以第一次拼好就记在
     * state.nightDigestText 里，发出去之前一直用它；入队去重按正文比
     * （pending-queue.js 的 pendingKey），同一段话不会排两遍。
     */
    const text = String(state.nightDigestText || '').trim() || buildDigestText({
      entries: journal,
      tickets: pendingCount(state, NIGHT_QUEUE),
      inbox: Array.isArray(state.nightInbox) ? state.nightInbox.length : 0,
    });
    if (!text) return { skipped: true };
    // 这一拍刚把排队的同一段汇总补发成功：账本盖戳收工，不再发第二条
    if (sentSayText && sentSayText === text) {
      for (const entry of journal) entry.digestAt = nowMs;
      state.nightDigestText = '';
      state.nightSentAt = nowMs;
      save();
      log(`night_digest:sent｜昨夜 ${journal.length} 条记录（走的是待发队列补发）`);
      return { ok: true };
    }
    if (state.nightDigestText !== text) {
      state.nightDigestText = text;
      save();
    }
    const sent = await ask(text, nowMs, { quiet: true });
    if (sent?.ok) {
      for (const entry of journal) entry.digestAt = nowMs;
      state.nightDigestText = '';
      state.nightSentAt = nowMs;
      save();
      log(`night_digest:sent｜昨夜 ${journal.length} 条记录`);
      return { ok: true };
    }
    // 排进 pendingSayQueue 也算暂时收着：正文不变，下一拍要么补发成功、要么超时后再拼一次
    log(`night_digest_wait:${nightOneLine(sent?.detail) || '没发出去'}｜正文已记下，下一拍再试`);
    return { waiting: true };
  }

  // ── 一拍：两段 + 三分支（night=true 时只换两个出口，提议/裁决/gate 全照旧） ──
  async function runRound(nowMs, { night = false } = {}) {
    state.lastAction = '';
    // 每拍开头按 mtime 看一眼台账：主会话新写的一行不用等重启
    adjudicator.getVetoLedger(nowMs);
    if (!cfg.proposer.enabled || !cfg.judge.enabled) {
      log(`有一段被关掉了（proposer=${cfg.proposer.enabled} judge=${cfg.judge.enabled}），这一拍不跑`);
      return { ok: true, action: 'skipped' };
    }
    const proposal = await proposer.propose(nowMs);
    /*
     * gate 拒：这一拍不动作，但不算「插件坏了」——不涨 failStreak，只记日志和 state。
     * 规则第七节的处置是「这一拍当失败，不动作」，失败在这里指「这一拍没有产出」，
     * 不是 stage2 调用失败那种要退避的失败。
     */
    if (proposal.gateRejected) {
      state.lastAction = 'silent';
      state.lastReason = String(proposal.why ?? '').slice(0, 200);
      log(`gate 拒了这一拍，不动作：${proposal.why}`);
      return { ok: true, action: 'silent', gateRejected: true, rewrites: 0 };
    }
    /*
     * 否决台账命中：同样不动作、不涨 failStreak，跟 gate 拒一个处置；
     * 日志在 checkVetoFor 里已经打过 veto_hit，这里只补 state。
     */
    if (proposal.vetoRejected) {
      state.lastAction = 'silent';
      state.lastReason = String(proposal.why ?? '').slice(0, 200);
      log(`veto 拒了这一拍，不动作：${proposal.why}`);
      return { ok: true, action: 'silent', vetoRejected: true, rewrites: Number(proposal.rewrites) || 0 };
    }
    if (!proposal.ok) {
      if (proposal.stage2Fail) {
        /*
         * stage2 失败：这一拍不动作（跟 silent 一样不产生任何消息），但仍记一次失败拍，
         * 让连败退避生效——stage2 每拍都失败还照跑，就是每拍烧一次钱。
         */
        state.lastAction = 'silent';
        state.lastReason = String(proposal.error ?? '').slice(0, 200);
        const streak = (Number(state.failStreak) || 0) + 1;
        if (streak >= 3) {
          log(`stage2FailStreak:${streak}｜连续这么多拍 stage2 拿不出方案，检查 stage2 提示词或候选表`);
        }
      }
      return { ok: false, error: proposal.error };
    }
    if (!proposal.idea) {
      // stage1 没格 / stage2 说这一格不值得做：直接当无动作，不叫终审，省一次调用
      state.lastAction = 'silent';
      state.lastReason = proposal.why.slice(0, 200);
      log(proposal.stage1Empty ? `stage1_empty:0｜${proposal.why}` : `stage2 说这一格不值得做：${proposal.why || '（没写为什么）'}`);
      return { ok: true, action: 'silent', rewrites: Number(proposal.rewrites) || 0 };
    }
    /*
     * 裁决已经在 propose 的 rewrite 循环里跑完了：打回重写的那几版也走同一条
     * gate → judge 路，循环用满按最后一次来源落回原处置（judge/原本降级→ask，原本拒→silent）。
     * 这里只接终判，不再叫一次终审。
     */
    // 终审失败走上面 !proposal.ok 那条，这里只兜「循环说定了却没给终判」的接线错
    if (!proposal.decision) return { ok: false, error: '这一拍没拿到裁决结果' };
    const rewrites = Math.max(0, Number(proposal.rewrites) || 0);
    /*
     * 路由前最后一道：reversibility=none 的 do 在这里就地改成 ask。
     * 不能靠 openTicket 返回 false——那会记一次失败、连涨 failStreak，
     * 把「这一步不该由机器做」记成「机器坏了」。
     */
    const settled = gate.settle(proposal.decision);
    let decision = settled.decision;
    if (settled.downgraded) {
      // 日志只记长度不记正文：原文（plan 回退拼的 goal）能上千字，剪进一行日志没意义
      log(`Gate 降级：${settled.notes.join('；')}｜原票面：${proposal.decision?.ticket?.goal ?? '（空）'}｜ask_text_len:${settled.askTextLen ?? 0}`);
    }
    /*
     * 方案校验的降级（GA7/GA8/GA11/GA12/GA13）：方案本身还能说，但不许直接开票。
     * 放在 routeDecision 之前、settle 之后，跟 none 档降级同一个位置。
     */
    if (Array.isArray(proposal.gateDowngrade) && proposal.gateDowngrade.length > 0 && decision.action === 'do') {
      const goal = String(decision.ticket?.goal ?? '').trim() || '这件事';
      const why = proposal.gateDowngrade.join('；');
      const askRaw = `${goal} —— ${why}，要开票吗？`;
      decision = {
        action: 'ask',
        text: clampAskText(askRaw),
        ticket: null,
        reason: [String(decision.reason ?? '').trim(), `gate 降级：${why}`].filter(Boolean).join('｜'),
        downgradedFrom: 'do',
      };
      log(`Gate 降级（方案校验）：${why}｜ask_text_len:${[...askRaw].length}`);
    }
    state.lastAction = decision.action;
    /*
     * lastRun 摘要（state.lastReason）带上这一拍重写了几次：state 不存计数（拍内的事），
     * 但摘要里要看得见，否则事后翻 state 只知道终判、不知道中间被打回过。
     */
    const reason = String(decision.reason ?? '').trim();
    state.lastReason = (rewrites > 0 ? `${reason || '（没写理由）'}｜重写${rewrites}次` : reason).slice(0, 200);
    log(`裁决：${decision.action}｜${reason || '（没写理由）'}${rewrites > 0 ? `｜重写${rewrites}次` : ''}${night ? '｜夜间' : ''}`);

    /*
     * 三分支路由：
     *   silent → 谁都不叫（这一支绝不产生任何消息，也不 followup 主会话）
     *   ask    → 白天 followup 一句话；夜里写进工单池等第二天定
     *   do     → 白天向主会话提开票申请；夜里进不过期的 nightTicket，早上再提
     */
    const ideaForNight = String(proposal.idea ?? '');
    const whyForNight = String(proposal.why ?? '');
    const routed = await routeDecision(decision, {
      ask: (text) => (night
        ? nightAsk(text, nowMs, { idea: ideaForNight, why: whyForNight, reason })
        : ask(text, nowMs)),
      openTicket: (ticket, meta) => (night
        ? queueNightTicket(ticket, nowMs, meta)
        : openTicket(ticket, nowMs, meta)),
    });
    // ego_tick 摘要要 judge 的终判和重写次数：routeDecision 只给落点，这里补上
    return { ...routed, verdict: decision.action, rewrites };
  }

  /** 正在补发待发队列：整点那一拍、补发盯梢、学习监听可能同时来，同一句只许发一次。 */
  let retryingPending = false;

  /**
   * 每拍先把存着的补上（pending 重试不看整点和骰子，它已经决定过要不要动作了）。
   * 队列逐条消费：每拍只说队头那句、只提队头那份开票申请，成功才出队；剩下的留给下一拍或补发盯梢。
   * 重入直接跳过：同一句被两条路同时补发就是两条消息（一条竞态的孪生坑）。
   *
   * 这一路跑在票台闸之前，而且**故意**不过闸：队列里的条目
   * 都是上一拍 judge 已经裁成 ask / do 之后、followup 发不出去才入队的，补发只调 ask() /
   * openTicket() 投递，不调 propose、不再过 gate/veto/judge，属于「执行已经批准的事」，
   * 跟「现在票台忙不忙」是两码事。反着改会让已批的事在 running 票横着时被 pendingTtl 吞掉。
   * 闸只挡「生成新想法」那一头，别把这里当缺口修。
   */
  async function retryPending(nowMs) {
    if (retryingPending) {
      log('补发待发队列已经在跑，这一路跳过（同一句不许发两遍）');
      return { skipped: true, reason: '正在补发' };
    }
    retryingPending = true;
    try {
      const { droppedSay, droppedTicket } = prunePending(state, nowMs, cfg.pendingTtlMinutes);
      if (droppedSay > 0 || droppedTicket > 0) {
        save();
        const parts = [];
        if (droppedSay > 0) parts.push(`话 ${droppedSay} 句`);
        if (droppedTicket > 0) parts.push(`票 ${droppedTicket} 张`);
        log(`存着的动作过期丢掉了：${parts.join('、')}（超过 ${cfg.pendingTtlMinutes} 分钟）`);
      }
      const say = pendingHead(state, 'say');
      let sentSayText = '';
      if (say) {
        const sent = await ask(say.text, nowMs, { quiet: true });
        if (sent.ok) {
          sentSayText = String(say.text ?? '');
          log(`存着的那句话补发出去了（队列里还剩 ${pendingCount(state, 'say')} 句）`);
        }
      }
      const ticket = pendingHead(state, 'ticket');
      if (ticket) {
        const opened = await openTicket(ticket, nowMs, { quiet: true, reason: ticket.reason });
        if (opened.ok) log(`存着的那份开票申请补发出去了（队列里还剩 ${pendingCount(state, 'ticket')} 张）`);
      }
      /*
       * 夜里的两张账也在这里收：drain 要等窗口恢复 + 主会话 idle，
       * 汇总要等窗口恢复。放在 retryPending 而不是掷骰之后，
       * 是为了「早上第一拍就算没掷中也能把夜里的东西交出去」。
       * 这两步都不看骰子、不调模型，属于执行已经批过的事。
       */
      await drainNightTickets(nowMs);
      // 把刚补发出去的那句正文带过去：它就是排队的夜间汇总时，别同一段话再发一遍
      await sendNightDigest(nowMs, { sentSayText });
      return { ok: true };
    } finally {
      retryingPending = false;
    }
  }

  function planNext(nowMs) {
    state.nextRunAt = nowMs + delayMs(new Date(nowMs), cfg);
  }

  let ticking = false;

  async function tick(nowMs = Date.now()) {
    if (!cfg.enabled || ticking) return;
    ticking = true;
    try {
      await retryPending(nowMs);
      if (state.retryAfterAt && nowMs < state.retryAfterAt) return;
      if (!state.nextRunAt || nowMs < state.nextRunAt) return;
      const now = new Date(nowMs);
      const window = speakingWindow(now, cfg);
      /*
       * 夜间分支：安静时段不再整夜停摆。
       * 判据只有一条 inNight（复用 inQuiet 的 23.66~8，另配 nightMode 开关），
       * 下面整段（票台闸、掷骰、runRound、连败退避）原样复用，只把落点换掉。
       * nightMode 关掉就完全回到老行为：这一支不进，直接跳过并排下一拍。
       */
      const night = !window.ok && inNight(now, cfg);
      if (!window.ok && !night) {
        planNext(nowMs);
        save();
        log(`跳过：${window.reason}，下一拍 ${fmt(state.nextRunAt)}`);
        return;
      }
      if (night) rollNightCounters(nowMs);
      /*
       * 票台闸：dispatcher 票台上只要有一张未终态的票
       * （open / running / waiting / blocked），这一拍就轮空——不掷骰、不提议、
       * 不开票、不发消息，只记 state.busySkips 和一行固定日志。
       *
       * 放在掷骰之前：这一拍反正要跳过，没必要先掷一次。手动催拍走
       * createManualTick → runForcedRound，不经过 tick()，所以不会被这道闸拦。
       *
       * 查不到票台也按「不空」处理（探针自己兜成 busy+unknown），宁可白等一拍，
       * 也不在票台状态不明时往正在干的活上插话。
       *
       * bus 的语义别简化成「读到 N > 0」：service 或 sqlite 任一源报 > 0 算忙，
       * 两个源都拿不到/都抛错也算忙；只有两源都确实读到 0 才放行往下掷骰。
       */
      if (cfg.skipWhenTicketsBusy !== false && typeof ticketProbe === 'function') {
        let probe;
        try {
          probe = await ticketProbe();
        } catch (error) {
          const reason = String(error?.message ?? error);
          probe = { busy: true, unknown: true, count: 0, source: 'none', error: reason, detail: `探针抛错：${reason}` };
        }
        // 每拍都留一行来源与读数（不只轮空时打）：下次再有人问「那拍读到了什么」，
        // 直接 grep `[ego] 票台探针` 看 source= 和 count=，不用回头猜探针走了哪条路。
        if (probe) log(formatProbeLog(probe));
        if (probe?.busy) {
          state.busySkips = (Number(state.busySkips) || 0) + 1;
          planNext(nowMs);
          save();
          log(probe.unknown ? formatUnknownLog(probe.error) : formatBusyLog(probe.count));
          return;
        }
      }
      // 闸过了才算真的掷了骰：轮空那一拍不刷 lastRunAt / lastRollAt
      state.lastRunAt = nowMs;
      state.lastRollAt = nowMs;
      const roll = rollDice();
      const hitLine = Number(cfg.diceProbability) * 100;
      if (!hit(roll, hitLine)) {
        planNext(nowMs);
        save();
        log(`掷出 ${roll}（命中线 ${hitLine}）没中，下一拍 ${fmt(state.nextRunAt)}`);
        return;
      }
      log(`掷出 ${roll}（命中线 ${hitLine}）中了，开始想点子${night ? '（夜间）' : ''}`);
      const result = await runRound(nowMs, { night });
      planNext(nowMs);
      if (result.ok) {
        recordSuccess(state);
      } else {
        recordFailure(state, nowMs, { maxFailStreak: cfg.maxFailStreak, backoffMinutes: cfg.backoffMinutes });
        log(`这一拍失败：${result.error || result.detail || '未知'}｜连败 ${state.failStreak}${state.retryAfterAt ? `，推到 ${fmt(state.retryAfterAt)}` : ''}`);
      }
      save();
    } catch (error) {
      log(`定时器抛错：${String(error?.message ?? error)}`);
    } finally {
      ticking = false;
    }
  }

  /*
   * ── 手动催一拍（调试 + ego_tick 工具） ─────────────────────
   * 两条入口共用 lib/ego-tick.js 的同一套语义：
   *   · touch 一下 cfg.forceTriggerPath（15 秒轮询）——老路，保留；
   *   · 主会话调 ego_tick 工具——不用碰文件，改完代码立刻验一拍。
   * 都跳骰子、跳安静/峰价、跳 nextRunAt 和连败推后；privateOnly、目标会话、互斥照旧。
   * touch 那一拍**不改** nextRunAt；ego_tick 额外不碰 failStreak（额外补跑，不占正常拍的位）。
   */
  const manualTick = createManualTick({
    state,
    cfg,
    targetId,
    scopeOf,
    isBusy: () => ticking,
    setBusy: (busy) => {
      ticking = busy;
    },
    runRound,
    save,
    log,
    getDryRunOverride: () => dryRunOverride,
    setDryRunOverride: (value) => {
      dryRunOverride = value;
    },
  });

  return {
    targetId,
    findAgent,
    ask,
    openTicket,
    nightAsk,
    queueNightTicket,
    drainNightTickets,
    sendNightDigest,
    planNext,
    runRound,
    retryPending,
    tick,
    manualTick,
    isBusy: () => ticking,
  };
}
