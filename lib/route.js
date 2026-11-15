/**
 * 裁决结果怎么落地：三分支路由 + 开票申请执行器。
 *
 * 单独一个文件，是因为它必须能在 `node --test` 里被 import：
 * lib/index.js 静态 import 了 @deepseek-ai/*（宿主的 peerDependencies，插件目录里不装），
 * 单测环境解析不到，路由就测不成了。这里只依赖 node 内置和纯函数模块。
 *
 * 开票这一支改成「提申请」：ego 不再借主会话身份执行开票工具，
 * 只往主会话 followup 一条固定格式的申请，由主会话自己开票、自己负责关票。
 * ego 这边只保证申请发出去（发不出去就进 pending 队列，下一拍重试）。
 */
import { randomUUID } from 'node:crypto';
import { ymd } from './window.js';
import { BRIEF_MAX_COLUMNS, truncateColumns } from './judge.js';
import { checkUndoHowto, normalizeIntent } from './gate.js';
import { ackPendingByKey, enqueuePending, findPendingTicketByContent } from './pending-queue.js';

/**
 * 把终审给的 ticket 规整成申请里的字段（brief 按列宽截断）。
 * intent 原样带上（已规整成固定形状）：放宽与否交给主会话判断，ego 不改写。
 */
export function normalizeTicket(ticket) {
  const goal = String(ticket?.goal ?? '').trim();
  if (!goal) return null;
  const brief = truncateColumns(String(ticket?.brief ?? '').trim() || goal, BRIEF_MAX_COLUMNS);
  const intent = normalizeIntent(ticket?.intent);
  return intent ? { goal, brief, intent } : { goal, brief };
}

/** undo.howto 看起来是具体命令或路径：至少含一个 `/` 或空格 */
const LOOKS_LIKE_COMMAND = /[/\s]/;

/** 日志里那截 undo 命令：压成单行、按字符截 60 字 */
function undoHead(howto, max = 60) {
  return [...String(howto ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

/** 单行化 + 去首尾空白：申请正文每个字段只占一行，主会话好解析 */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 按字符截断（不切坏代理对） */
function clip(value, max) {
  return [...String(value ?? '')].slice(0, max).join('');
}

/**
 * dryRun 放行：ego 自己开的写类票，终审一律写 dryRun.ok=false
 * （「需在进程内实读一次验证」），它自己在那一拍里做不到，dispatcher 就把票停在
 * waiting 等用户，每张都要人工回收。这里只在「可自动回滚 + undo 给了具体命令」
 * 时放宽这一栏，其余情形原样返回，继续停 waiting 等用户。
 *
 * 只读 undo 的判定（GA6/GA7 仍由 gate 管，这里不重复也不削弱）：
 *   - reversibility 必须是 auto（manual 要人动手撤、none 撤不回来，都不放宽）
 *   - undo.howto 要过 checkUndoHowto 的空话表与长度下限
 *   - 还要看得出是命令或路径（含 `/` 或空格），光一句「revert it」不算
 *
 * 注意：ego 现在不再自己开票，这条放宽没有调用点了（函数留着给回滚/别处引用）。
 * 申请里的 intent 原样透传，放不放宽由主会话判断。
 *
 * @param {object|null} intent normalizeIntent 的结果
 * @returns {object|null} 放宽后的新对象（不改原对象），或原样返回
 */
export function relaxDryRun(intent, { log = () => {} } = {}) {
  if (!intent || intent.dryRun?.ok !== false) return intent;
  if (intent.reversibility !== 'auto') return intent;
  const howto = String(intent?.undo?.howto ?? '').trim();
  if (!checkUndoHowto(howto).ok) return intent;
  if (!LOOKS_LIKE_COMMAND.test(howto)) return intent;
  const detail = '未预演：方案自身无法在本拍内执行验证；因可自动回滚（undo 已给具体命令）放行。原说明：'
    + String(intent.dryRun.detail ?? '');
  log(`dryrun_relaxed:auto｜undo:${undoHead(howto)}`);
  return { ...intent, dryRun: { ok: true, detail } };
}

/**
 * 已经提上去的申请记录上限：只用来防同一 callId 重复发，不参与补发。
 * 超过就丢最旧的，免得 state 越写越大。
 */
export const TICKET_REQUEST_LIMIT = 50;

function requestedTickets(state) {
  if (!Array.isArray(state.ticketRequests)) state.ticketRequests = [];
  return state.ticketRequests;
}

function findRequestedTicketByContent(state, { goal = '', brief = '' } = {}) {
  return (
    requestedTickets(state).find(
      (entry) => String(entry.goal ?? '') === String(goal) && String(entry.brief ?? '') === String(brief),
    ) ?? null
  );
}

function findRequestedTicketByCallId(state, callId) {
  return requestedTickets(state).find((entry) => String(entry.callId ?? '') === String(callId)) ?? null;
}

function rememberRequestedTicket(state, entry) {
  const list = requestedTickets(state);
  if (findRequestedTicketByCallId(state, String(entry.callId ?? ''))) return;
  list.push(entry);
  while (list.length > TICKET_REQUEST_LIMIT) list.shift();
}

/**
 * callId 稳定即幂等：同一条内容（goal+brief 都没变）沿用原 callId，
 * 重放不会提第二份申请；换了内容才按 seq 新开一个。
 * 去重范围包含「还没发出去的 pending」和「已经提上去的记录」：
 * 前者防重复入队，后者防同一份申请一拍一拍地提。
 * 注意：seq 只在这里递增，调用方必须在执行前先把它落盘。
 */
export function ticketCallId(state, nowMs, { goal = '', brief = '' } = {}) {
  const prev = findPendingTicketByContent(state, { goal, brief })
    ?? findRequestedTicketByContent(state, { goal, brief });
  if (prev && prev.callId && String(prev.goal ?? '') === String(goal) && String(prev.brief ?? '') === String(brief)) {
    return String(prev.callId);
  }
  state.ticketSeq = (Number(state.ticketSeq) || 0) + 1;
  return `proactive-${ymd(new Date(nowMs))}-${state.ticketSeq}`;
}

/**
 * 申请正文：固定格式、固定字段顺序，主会话按行解析。
 * 每个字段压成单行；intent 给 JSON 原文（没有就写 null）。
 */
export function buildTicketRequest({ callId = '', goal = '', brief = '', intent = null, note = '' } = {}) {
  return [
    '【开票申请·dsh-ego】',
    `callId: ${oneLine(callId)}`,
    `goal: ${oneLine(goal)}`,
    `brief: ${oneLine(brief)}`,
    `intent: ${intent ? JSON.stringify(intent) : 'null'}`,
    `note: ${oneLine(note)}`,
  ].join('\n');
}

/**
 * 申请里的 note：一句为什么想开这张票；dryRun.ok=false 时把 undo.howto 写清、并说明能不能撤。
 */
export function buildTicketNote({ reason = '', intent = null } = {}) {
  const why = oneLine(reason) || '裁决判了「直接做」，这一步该落成一张票';
  const dry = intent?.dryRun;
  if (!dry || dry.ok !== false) return why;
  const howto = oneLine(intent?.undo?.howto) || '（没给具体命令）';
  const undo = intent?.reversibility === 'auto'
    ? '可自动回滚'
    : intent?.reversibility === 'manual'
      ? '要人动手撤'
      : intent?.reversibility === 'none'
        ? '撤不回来'
        : '没写可撤性';
  return `${why}；dryRun 未过（${oneLine(dry.detail) || '没写原因'}），动手前得自己验一次；撤销方式：${howto}（${undo}）`;
}

/**
 * 票入队（去重键是 callId）：同 callId 重复入队沿用原 at，不刷新 TTL；
 * 不同 callId 追加到队尾，不覆盖前面还没提上去的申请。
 */
function rememberPendingTicket(state, entry, { log = () => {}, save = () => {} } = {}) {
  enqueuePending(state, 'ticket', entry, { log });
  save();
}

/**
 * 开票申请执行器：往主会话 followup 一条申请，开票动作由主会话自己执行。
 * 依赖全注入，单测里给一个带 followup 的假 agent 就行，不会真发消息。
 *
 * @param {object} deps
 * @param {(id: string) => object|undefined} deps.findAgent 找活着的 agent
 * @param {() => string} deps.targetId 主会话（学到的私聊会话）
 * @param {object} deps.state 状态对象（会被就地改写）
 * @param {() => void} deps.save 落盘
 * @param {(agent: object) => any} [deps.flush] 落盘确认（主会话会话 flush）
 * @param {(line: string) => void} deps.log
 * @param {boolean|(() => boolean)} [deps.dryRun] 固定值，或每次调用时读一次（ego_tick 要临时覆盖）
 * @param {number} [deps.openTimeoutMs] followup 的超时
 */
export function createTicketOpener(deps) {
  const {
    findAgent,
    targetId,
    state,
    save,
    flush,
    log = () => {},
    dryRun = false,
    openTimeoutMs = 30_000,
  } = deps;
  const isDryRun = typeof dryRun === 'function' ? dryRun : () => Boolean(dryRun);

  return async function requestTicket(ticket, nowMs, { quiet = false, reason = '' } = {}) {
    const normalized = normalizeTicket(ticket);
    if (!normalized) return { ok: false, detail: '终审给的 goal 是空的' };
    const { goal, brief, intent } = normalized;
    const callId = ticketCallId(state, nowMs, { goal, brief });

    if (isDryRun()) {
      log(`[dry] 本来要向主会话提开票申请：${goal}｜票面：${brief}｜callId=${callId}`);
      return { ok: true, dry: true, callId };
    }

    // 同一 callId 已经提过：不重复发，主会话那边不会收到两份一样的申请
    if (findRequestedTicketByCallId(state, callId)) {
      log(`ticket_request:skip｜callId:${callId}｜why:同一 callId 已经提过`);
      return { ok: true, duplicate: true, callId };
    }

    // 不许自建假主会话去提申请：先存着，每拍重试，过期丢
    const agent = findAgent(targetId());
    const blocked = !agent
      ? '主会话不在活表'
      : agent.status !== undefined && agent.status !== 'idle'
        ? `主会话正忙（${agent.status}）`
        : '';
    if (blocked) {
      rememberPendingTicket(state, { goal, brief, intent, callId, reason, at: nowMs }, { log, save });
      if (!quiet) log(`ticket_request:pending｜callId:${callId}｜why:${oneLine(blocked)}`);
      return { ok: false, pending: true, detail: blocked, callId };
    }

    const body = buildTicketRequest({
      callId,
      goal,
      brief,
      intent,
      note: buildTicketNote({ reason, intent }),
    });

    // 先把 callId 落盘再发：进程半路崩了，重放还是同一个 callId
    rememberPendingTicket(state, { goal, brief, intent, callId, reason, at: nowMs }, { log, save });

    let timer;
    try {
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: 'dsh-ego' },
      };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`超时（${Math.max(1, Math.round(openTimeoutMs / 1000))} 秒）`)),
          openTimeoutMs,
        );
        if (typeof timer?.unref === 'function') timer.unref();
      });
      await Promise.race([Promise.resolve(agent.followup(message)), timeout]);
    } catch (error) {
      const why = `followup 失败：${String(error?.message ?? error)}`;
      log(`ticket_request:pending｜callId:${callId}｜why:${clip(oneLine(why), 160)}`);
      return { ok: false, detail: why, callId };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    try {
      if (typeof flush === 'function') await flush(agent);
    } catch {
      /* 落盘确认失败无所谓：申请已经递出去了 */
    }

    // 真发出去了才销账，并记进「已提」表，同一 callId 不再发
    ackPendingByKey(state, 'ticket', { callId });
    rememberRequestedTicket(state, { callId, goal, brief, at: nowMs });
    save();
    log(`ticket_request:sent｜callId:${callId}｜goal:${clip(oneLine(goal), 60)}`);
    return { ok: true, requested: true, callId };
  };
}

/**
 * 三分支路由。这一层只决定叫谁，不自己发消息、不自己提开票申请：
 *   silent → 谁都不叫（用户什么都看不见）
 *   ask    → handlers.ask(要说的话)
 *   do     → handlers.openTicket(ticket, { reason })（执行体向主会话提申请）
 *
 * @param {{action: string, text?: string, ticket?: object, reason?: string}} decision
 * @param {{ask?: Function, openTicket?: Function}} handlers
 */
export async function routeDecision(decision, handlers = {}) {
  const action = String(decision?.action ?? '');
  if (action === 'silent') return { ok: true, action: 'silent', called: false };
  if (action === 'ask') {
    const text = String(decision?.text ?? '').trim();
    if (!text) return { ok: false, action, error: 'ask 没有要说的那句话', called: false };
    const sent = await handlers.ask?.(text);
    return {
      ok: Boolean(sent?.ok),
      action,
      called: true,
      pending: Boolean(sent?.pending),
      detail: sent?.detail,
      dry: Boolean(sent?.dry),
    };
  }
  if (action === 'do') {
    const normalized = normalizeTicket(decision?.ticket);
    if (!normalized) return { ok: false, action, error: 'do 没有要干什么', called: false };
    const opened = await handlers.openTicket?.(normalized, { reason: String(decision?.reason ?? '').trim() });
    return {
      ok: Boolean(opened?.ok),
      action,
      called: true,
      pending: Boolean(opened?.pending),
      detail: opened?.detail,
      ticket: opened?.ticket,
      callId: opened?.callId,
      duplicate: Boolean(opened?.duplicate),
      dry: Boolean(opened?.dry),
    };
  }
  return { ok: false, action, error: `未知动作 ${action || '(空)'}`, called: false };
}
