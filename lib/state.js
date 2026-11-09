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
 *   lastTicket      最近开的票号
 *   ticketSeq       开票序号（callId 的稳定尾巴）
 *   failStreak      连续失败拍数
 *   retryAfterAt    连败推后到什么时候
 *   pendingSayQueue    [{ id, text, at }]：想问用户但目标会话不在活表/正忙（有序队列）
 *   pendingTicketQueue [{ id, goal, brief, callId, at }]：想开票但主会话不在活表
 *   pendingSeq      队列条目 id 的递增序号
 *   pendingSay / pendingTicket  旧单槽，只留给回滚兼容，新代码不读不写（读到就迁移）
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
    ticketSeq: 0,
    failStreak: 0,
    retryAfterAt: 0,
    pendingSayQueue: [],
    pendingTicketQueue: [],
    pendingSeq: 0,
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
  for (const field of ['pendingSayQueue', 'pendingTicketQueue']) {
    if (!Array.isArray(state[field])) state[field] = [];
  }
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
