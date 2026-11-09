/**
 * 裁决结果怎么落地：三分支路由 + 开票执行器。
 *
 * 单独一个文件，是因为它必须能在 `node --test` 里被 import：
 * lib/index.js 静态 import 了 @deepseek-ai/*（宿主的 peerDependencies，插件目录里不装），
 * 单测环境解析不到，路由就测不成了。这里只依赖 node 内置和纯函数模块。
 */
import { ymd } from './window.js';
import { BRIEF_MAX_COLUMNS, truncateColumns } from './judge.js';
import { ackPendingByKey, enqueuePending, findPendingTicketByContent } from './pending-queue.js';

/** 把裁决器给的 ticket 规整成能交给 dispatch_open 的形状（brief 按列宽截断） */
export function normalizeTicket(ticket) {
  const goal = String(ticket?.goal ?? '').trim();
  if (!goal) return null;
  const brief = truncateColumns(String(ticket?.brief ?? '').trim() || goal, BRIEF_MAX_COLUMNS);
  return { goal, brief };
}

/**
 * callId 稳定即幂等：同一条存着的票（goal+brief 都没变）沿用原 callId，
 * 重放不会开第二张；换了内容才按 seq 新开一个。
 * 队列化之后去重范围是整条队列，不再只看单槽：只要队列里还有同内容的票，就沿用它的 callId。
 * 注意：seq 只在这里递增，调用方必须在执行前先把它落盘。
 */
export function ticketCallId(state, nowMs, { goal = '', brief = '' } = {}) {
  const prev = findPendingTicketByContent(state, { goal, brief });
  if (prev && prev.callId && String(prev.goal ?? '') === String(goal) && String(prev.brief ?? '') === String(brief)) {
    return String(prev.callId);
  }
  state.ticketSeq = (Number(state.ticketSeq) || 0) + 1;
  return `proactive-${ymd(new Date(nowMs))}-${state.ticketSeq}`;
}

/**
 * 票入队（去重键是 callId）：同 callId 重复入队沿用原 at，不刷新 TTL；
 * 不同 callId 追加到队尾，不覆盖前面还没开成的票。
 */
function rememberPendingTicket(state, entry, { log = () => {}, save = () => {} } = {}) {
  enqueuePending(state, 'ticket', entry, { log });
  save();
}

/**
 * 开票执行器。依赖全注入，单测里给假的 tools.execute 就行，不会真开票。
 *
 * @param {object} deps
 * @param {{executable?: Function, execute?: Function}} deps.tools ctx.tools
 * @param {(id: string) => object|undefined} deps.findAgent 找活着的 agent
 * @param {() => string} deps.targetId 主会话（学到的私聊会话）
 * @param {object} deps.state 状态对象（会被就地改写）
 * @param {() => void} deps.save 落盘
 * @param {(line: string) => void} deps.log
 * @param {boolean} [deps.dryRun]
 * @param {number} [deps.openTimeoutMs]
 */
export function createTicketOpener(deps) {
  const { tools, findAgent, targetId, state, save, log = () => {}, dryRun = false, openTimeoutMs = 30_000 } = deps;

  return async function openTicket(ticket, nowMs, { quiet = false } = {}) {
    const normalized = normalizeTicket(ticket);
    if (!normalized) return { ok: false, detail: '裁决器给的 goal 是空的' };
    const { goal, brief } = normalized;
    const callId = ticketCallId(state, nowMs, { goal, brief });

    if (dryRun) {
      log(`[dry] 本来要开票：${goal}｜票面：${brief}｜callId=${callId}`);
      return { ok: true, dry: true, callId };
    }

    const mainAgent = findAgent(targetId());
    if (!mainAgent) {
      // 不许自建假主会话去开票：先存着，每拍重试，过期丢
      rememberPendingTicket(state, { goal, brief, callId, at: nowMs }, { log, save });
      if (!quiet) log(`主会话不在活表，票先存着（callId=${callId}）`);
      return { ok: false, pending: true, detail: '主会话不在活表', callId };
    }

    // 存在性用 get(name, mainAgent)：它就是 view(主会话).visible，条件注册也算在内。
    // 旧代码用 executable()，那是「这一步能不能执行」的判据：不带 toolSet 时对带 when
    // 的注册一律返回 undefined（dsh-tools 0.2.2 lib/index.js:530-534），探存在会漏。
    // get 不在的老宿主上退回 executable。
    let visible = false;
    try {
      if (typeof tools?.get === 'function') visible = Boolean(tools.get('dispatch_open', mainAgent));
      else visible = Boolean(tools?.executable?.('dispatch_open', mainAgent));
    } catch {
      visible = false;
    }
    if (!visible) {
      // dispatcher 可能还没挂上（它是最后一层 bundle）或主会话被 restrict 掉了：
      // 票不丢，存着按 pending 重试；日志说清楚是「看不见」而不是「不在活表」
      rememberPendingTicket(state, { goal, brief, callId, at: nowMs }, { log, save });
      if (!quiet) log(`主会话视角看不见 dispatch_open（dispatcher 没挂/被 restrict 掉了），票先存着（callId=${callId}）`);
      return { ok: false, pending: true, detail: '主会话看不见 dispatch_open', callId };
    }

    // 先把 callId 落盘再执行：进程半路崩了，重放还是同一个 callId
    rememberPendingTicket(state, { goal, brief, callId, at: nowMs }, { log, save });

    // ⚠ 不传 log：传了会往主会话写 tool/call 事件，主会话历史就脏了
    let reply;
    try {
      reply = await tools.execute({
        calls: [{ type: 'tool-call', id: callId, name: 'dispatch_open', arguments: JSON.stringify({ goal, brief }) }],
        signal: AbortSignal.timeout(openTimeoutMs),
        agent: mainAgent,
      });
    } catch (error) {
      return { ok: false, detail: `开票抛了：${String(error?.message ?? error)}`, callId };
    }

    const outcome = reply?.results?.[0]?.result;
    const text = (outcome?.content ?? [])
      .filter((block) => block && block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
      .trim();
    if (!outcome || outcome.isError) {
      return { ok: false, detail: `开票失败：${text || '没有回执'}`, callId };
    }

    const matched = /t-[a-z0-9]{4,}-[a-z0-9]{3,}/i.exec(text);
    state.lastTicket = matched ? matched[0] : '';
    // 出队确认：真开成票了才把这条从队列里摘掉
    ackPendingByKey(state, 'ticket', { callId });
    save();
    log(`已开票：${text ? text.split('\n')[0].slice(0, 160) : '（回执没有正文）'}`);
    return { ok: true, ticket: state.lastTicket, callId };
  };
}

/**
 * 三分支路由。这一层只决定叫谁，不自己发消息、不自己开票：
 *   silent → 谁都不叫（用户什么都看不见）
 *   ask    → handlers.ask(要说的话)
 *   do     → handlers.openTicket(ticket)
 *
 * @param {{action: string, text?: string, ticket?: object}} decision
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
    const opened = await handlers.openTicket?.(normalized);
    return {
      ok: Boolean(opened?.ok),
      action,
      called: true,
      pending: Boolean(opened?.pending),
      detail: opened?.detail,
      ticket: opened?.ticket,
      callId: opened?.callId,
      dry: Boolean(opened?.dry),
    };
  }
  return { ok: false, action, error: `未知动作 ${action || '(空)'}`, called: false };
}
