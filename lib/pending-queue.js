/**
 * pending 的有序队列：存着没说出口的话（say）和没开成的票（ticket）。
 *
 * 为什么从单槽改队列：单槽是直接赋值，后到的念头把先到的整条覆盖掉，日志里
 * 一个字都不留。改成有序队列后：按产生时间、可多元素、出队有确认，三条互不覆盖。
 *
 * 约定：
 *   - 条目自带 `id`，只由 state.pendingSeq 递增产生，跨进程稳定（跟着 state 落盘）。
 *   - 去重键（key）：say 用正文，ticket 用 callId（没 callId 时退回 goal+brief）。
 *     依据是原实现：index.js 的 rememberSay 对同文本沿用原 at（不刷新 TTL），
 *     route.js 对同 callId 沿用原 at。同一条东西重复入队不该变成两条。
 *   - 出队有确认：`head` 只读，`ack` 才真删；发出去 / 开成票才 ack。
 *   - 上限 50：超出丢最旧的，丢几条记几条日志。
 *   - 队列跟着 state 文件落盘（跟原来的单槽一样），不额外加持久化。
 */

/** 每类队列的上限；超出丢最旧的 */
export const PENDING_LIMIT = 50;

const QUEUE_FIELD = { say: 'pendingSayQueue', ticket: 'pendingTicketQueue' };
const LEGACY_FIELD = { say: 'pendingSay', ticket: 'pendingTicket' };

export function queueField(kind) {
  return QUEUE_FIELD[kind];
}

/** 取队列本体（顺手把坏值掰成数组，状态文件被手改坏也不许抛） */
export function queueOf(state, kind) {
  const field = QUEUE_FIELD[kind];
  if (!field) throw new Error(`未知的 pending 类型：${kind}`);
  if (!Array.isArray(state[field])) state[field] = [];
  return state[field];
}

export function pendingCount(state, kind) {
  return queueOf(state, kind).length;
}

/** 队列头（最早入库的那条），不看 TTL：TTL 由调用方先 prune */
export function pendingHead(state, kind) {
  return queueOf(state, kind)[0] ?? null;
}

export function hasPendingItems(state) {
  return pendingCount(state, 'say') > 0 || pendingCount(state, 'ticket') > 0;
}

/** 去重键：同 key 视为同一条，不重复入队 */
export function pendingKey(kind, entry) {
  if (kind === 'say') return String(entry?.text ?? '');
  const callId = String(entry?.callId ?? '');
  if (callId) return callId;
  return `${String(entry?.goal ?? '')}\u0000${String(entry?.brief ?? '')}`;
}

/**
 * 按内容找存着的票（开票幂等要用：同 goal+brief 沿用原 callId）。
 * 这里按 goal+brief 逐字比，不走 pendingKey——入队去重键是 callId，
 * 内容查找的时候手上只有 goal/brief，没有 callId。
 */
export function findPendingTicketByContent(state, { goal = '', brief = '' } = {}) {
  return (
    queueOf(state, 'ticket').find(
      (entry) => String(entry.goal ?? '') === String(goal) && String(entry.brief ?? '') === String(brief),
    ) ?? null
  );
}

export function findPendingById(state, kind, id) {
  if (!id) return null;
  return queueOf(state, kind).find((entry) => entry.id === id) ?? null;
}

/** 队列里还有没有这一句（开机自报补发盯梢用：发成功 ask 会 ack，条目消失就是补完了） */
export function hasPendingText(state, kind, text) {
  const key = pendingKey(kind, { text });
  return queueOf(state, kind).some((entry) => pendingKey(kind, entry) === key);
}

/**
 * 入队。按 at 有序插入（同 at 的放后面，保持产生顺序）。
 * 同 key 已在队列里：不重复入队、不刷新 at，返回 { added: false, duplicate: true }。
 *
 * @returns {{added: boolean, duplicate: boolean, id: string|null, dropped: number}}
 */
export function enqueuePending(state, kind, entry, { log = () => {}, limit = PENDING_LIMIT } = {}) {
  const queue = queueOf(state, kind);
  const key = pendingKey(kind, entry);
  const existing = queue.find((item) => pendingKey(kind, item) === key);
  if (existing) return { added: false, duplicate: true, id: existing.id, dropped: 0 };

  state.pendingSeq = (Number(state.pendingSeq) || 0) + 1;
  const id = `p${state.pendingSeq}`;
  const item = { ...entry, id };
  const at = Number(item.at) || 0;
  let index = queue.length;
  while (index > 0 && Number(queue[index - 1].at) > at) index -= 1;
  queue.splice(index, 0, item);

  let dropped = 0;
  while (queue.length > limit) {
    queue.shift();
    dropped += 1;
  }
  if (dropped > 0) {
    log(`pending 队列满了（上限 ${limit} 条），丢掉最旧的 ${dropped} 条`);
  }
  return { added: true, duplicate: false, id, dropped };
}

/** 出队确认：真发出去 / 真开成票才调它。返回删掉了几条 */
export function ackPending(state, kind, id) {
  const queue = queueOf(state, kind);
  const index = queue.findIndex((entry) => entry.id === id);
  if (index < 0) return 0;
  queue.splice(index, 1);
  return 1;
}

/** 按内容确认出队（新念头直接发成功时，把队列里同一句一并销掉） */
export function ackPendingByKey(state, kind, entry) {
  const queue = queueOf(state, kind);
  const key = pendingKey(kind, entry);
  const before = queue.length;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (pendingKey(kind, queue[index]) === key) queue.splice(index, 1);
  }
  return before - queue.length;
}

/**
 * 清过期：整条队列扫一遍，过期的摘掉，返回摘了几条。
 * 原单槽每拍只看一条，队列化后过期判断必须扫全队列，不然队头活着、队尾烂着也没人管。
 */
export function pruneQueue(state, kind, now, ttlMs, isExpired) {
  const queue = queueOf(state, kind);
  const before = queue.length;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (isExpired(queue[index], now, ttlMs)) queue.splice(index, 1);
  }
  return before - queue.length;
}

/**
 * 老状态文件迁移：旧单槽（pendingSay / pendingTicket）有值就搬进队列，然后清空旧字段。
 * 不判断队列空不空——回滚期间旧代码可能又往单槽写了值，队列里已有别的条目也得搬；
 * 重复搬由入队去重键兜住，同内容不会变成两条。
 */
export function migrateLegacyPending(state, { log = () => {} } = {}) {
  for (const kind of ['say', 'ticket']) {
    const legacy = state[LEGACY_FIELD[kind]];
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) continue;
    const entry = { ...legacy };
    entry.at = Number(entry.at) || 0;
    if (kind === 'ticket' && !entry.callId) entry.callId = '';
    enqueuePending(state, kind, entry, { log });
    log(`旧单槽里的 ${LEGACY_FIELD[kind]} 搬进队列了`);
  }
  state.pendingSay = null;
  state.pendingTicket = null;
  return state;
}
