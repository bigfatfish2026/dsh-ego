/**
 * 状态文件：state 里只放「跨进程还要记住的事」，纯函数部分（TTL、连败推后）单独导出，
 * 好让单测不碰磁盘。
 *
 * 字段：
 *   targetSession   学到的 私聊会话 id（config.targetSession 优先）
 *   nextRunAt       下一拍的时间戳（整点 + 随机延迟）
 *   lastRunAt       上一次真的掷了骰子的时间
 *   lastRollAt      上一次掷骰的时间（含没中）
 *   lastSpokeAt     上次开口（followup）的时间
 *   lastAskAt       上次走 ask 分支的时间
 *   lastReportAt    上次让用户「知道点事」的时间（ask 或 do 成功）
 *   lastAction      最近一次裁决结果 silent|ask|do
 *   lastReason      最近一次裁决理由（截 200 字）
 *   lastTicket      最近开的票号（ego 现在只提申请、不自己开票，这个字段只留给旧状态）
 *   lastSelfIdeaAt  上个「自我优化方向」点子的时间（12 小时冷却的锚点，缺省 0）
 *   recentCombos    最近几拍提过的「对」：`读原语|读对象→动作原语|动作对象`；
 *                   单段读写成箭尾留空的 `读原语|读对象→`（统一约定：不带箭头的老单格
 *                   写法会被丢，单段那一格就永远不轮换）。最多 10 条；stage1 命中整对剔掉、
 *                   并按读对象算新鲜度。老的一格格式（不含 `→`）读到直接丢
 *   lastActionCells 上一拍用掉的动作格（`原语|对象`，最多 2 条）：stage1 剔它，动作格不许连续两拍
 *   lastGridSeed    上一拍 stage1 加权抽取用的 seed（整数）：拿它重跑 buildGrid 就能复现抽到哪一格
 *   ticketSeq       开票申请序号（callId 的稳定尾巴）
 *   ticketRequests  [{ callId, goal, brief, at }]：已经提上去的申请（防同一 callId 重复发，最多 50 条）
 *   failStreak      连续失败拍数
 *   retryAfterAt    连败推后到什么时候
 *   pendingSayQueue    [{ id, text, at }]：想问用户但目标会话不在活表/正忙（有序队列）
 *   pendingTicketQueue [{ id, goal, brief, intent, callId, reason, at }]：开票申请没发出去（主会话不在活表/正忙）
 *   pendingSeq      队列条目 id 的递增序号
 *   pendingSay / pendingTicket  旧单槽，只留给回滚兼容，新代码不读不写（读到就迁移）
 *   busySkips       票台闸累计轮空次数（票台有未终态票、或查不到票台时跳过的那几拍）
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrateLegacyPending, pendingHead, pruneQueue } from './pending-queue.js';

export const STATE_VERSION = 1;

export function defaultState() {
  return {
    version: STATE_VERSION,
    targetSession: '',
    nextRunAt: 0,
    lastRunAt: 0,
    lastRollAt: 0,
    lastSpokeAt: 0,
    lastAskAt: 0,
    lastReportAt: 0,
    lastAction: '',
    lastReason: '',
    lastTicket: '',
    lastSelfIdeaAt: 0,
    // 上一拍用掉的素材：gate 的 GA13 轻校验读它（同一素材不许连续两拍）
    lastMaterial: '',
    recentCombos: [],
    // 上一拍用掉的动作格（`edit-file|files` 这种）：这一拍不许连用同一个动作格
    lastActionCells: [],
    // 上一拍 stage1 加权抽取的 seed：事后复现那一拍抽到哪一格
    lastGridSeed: 0,
    ticketSeq: 0,
    failStreak: 0,
    retryAfterAt: 0,
    pendingSayQueue: [],
    pendingTicketQueue: [],
    // 已经提上去的开票申请：同一 callId 不再发第二遍
    ticketRequests: [],
    pendingSeq: 0,
    // 票台闸轮空次数：跨重启累计，方便事后看它到底白等了多少拍
    busySkips: 0,
    // 旧单槽：只为回滚保留字段形状，新代码一律走上面两个队列
    pendingSay: null,
    pendingTicket: null,
  };
}

export function ensureDir(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* 建不了就算了，后面写会报错 */
  }
}

/** 读状态；文件不在或坏了都给一份干净的默认值，绝不让插件因为状态坏了不跑 */
export function readState(file) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  const state = { ...defaultState(), ...parsed };
  for (const field of ['pendingSayQueue', 'pendingTicketQueue', 'ticketRequests', 'recentCombos', 'lastActionCells']) {
    if (!Array.isArray(state[field])) state[field] = [];
  }
  /*
   * 两段式换了记账口径（规则第七节）：老状态里的 `inspect|files` 是「一格」，
   * 新的对必须带 `→`，两者混在一起算新鲜度会把读格算重。老条目直接丢，重来一轮即可——
   * 这一条写在这里而不是 grid，是因为读盘只在 state 这一层，grid 拿到的必须已经是干净口径。
   */
  // 只认字符串：数字/null 一律丢，别让 String() 把 1 变成 '1' 混进键表
  state.recentCombos = state.recentCombos
    .filter((one) => typeof one === 'string')
    .map((one) => one.trim())
    .filter((one) => one.includes('→'));
  state.lastActionCells = state.lastActionCells
    .filter((one) => typeof one === 'string')
    .map((one) => one.trim())
    .filter((one) => one && !one.includes('→'));
  // 老状态文件里的单槽搬进队列：重启不丢还没说出口的那句话
  migrateLegacyPending(state);
  return state;
}

/** 先写 tmp 再 rename：断电最多丢一拍，不会留下半个 json */
export function writeState(file, state) {
  try {
    ensureDir(file);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** pending 条目过没过期（没有 at 的当过期，TTL ≤ 0 当不过期） */
export function isExpired(entry, now, ttlMs) {
  if (!entry) return true;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  const at = Number(entry.at);
  if (!Number.isFinite(at) || at <= 0) return true;
  return now - at >= ttlMs;
}

/**
 * 看这一拍还能不能用 pending：每类队伍各扫一遍清过期的，队头返回给调用方去重试。
 * 不改 state 以外的副作用——过期条目已经就地摘掉了，落盘由调用方决定。
 * @returns {{say: object|null, ticket: object|null, droppedSay: number, droppedTicket: number}}
 */
export function prunePending(state, now, ttlMinutes = 30) {
  const ttlMs = Number(ttlMinutes) * 60 * 1000;
  const droppedSay = pruneQueue(state, 'say', now, ttlMs, isExpired);
  const droppedTicket = pruneQueue(state, 'ticket', now, ttlMs, isExpired);
  return {
    say: pendingHead(state, 'say'),
    ticket: pendingHead(state, 'ticket'),
    droppedSay,
    droppedTicket,
  };
}

/** 记一次失败：连续 maxFailStreak 拍就推后 backoffMinutes，之后每拍继续往后推 */
export function recordFailure(state, now, { maxFailStreak = 3, backoffMinutes = 60 } = {}) {
  state.failStreak = (Number(state.failStreak) || 0) + 1;
  if (state.failStreak >= maxFailStreak) {
    state.retryAfterAt = now + Number(backoffMinutes) * 60 * 1000;
  }
  return state.failStreak;
}

/** 成功一拍：连败清零，惩罚解除 */
export function recordSuccess(state) {
  state.failStreak = 0;
  state.retryAfterAt = 0;
}
