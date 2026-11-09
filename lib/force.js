/**
 * 手动催一拍（调试用）
 *
 * 用户想现在验一次「提议器 → 裁决器」链路，不用等 18:05 掷骰子。
 * 做法：插件轮询一个触发文件，看到就删掉，然后立刻跑一拍。
 *
 * 这一拍**跳过**的：
 *   · 骰子（强制命中）；
 *   · 安静时段 / 峰价窗口（debug 不受时段限制）；
 *   · `nextRunAt` 排期（不等自己那一拍到点）；
 *   · 连败推后 `retryAfterAt`（debug 就是现在要跑）。
 *
 * 这一拍**保留**的：
 *   · `enabled` 总开关；
 *   · `privateOnly`（目标会话不是私聊就拒，跟正常拍一个口径）；
 *   · 必须有目标会话（`targetSession` 配置或学到的），没有就拒；
 *   · 同一时刻只跑一拍：上一拍还在跑就拒，不排队。
 *
 * 跑完**不动** `nextRunAt`：正常排期照旧，debug 只是插了一拍。
 * `failStreak` 按正常拍处理：成功清零、失败 +1（失败也照常推 `retryAfterAt`）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectScope } from './scope.js';
import { recordFailure, recordSuccess } from './state.js';

/** 默认触发文件：放在插件自己的数据目录里，可用 `forceTriggerPath` 改。 */
export const DEFAULT_FORCE_PATH = path.join(os.homedir(), '.dsh-ego', 'force');
export const DEFAULT_FORCE_INTERVAL_MS = 15_000;

/**
 * 能不能手动催这一拍（纯函数，单测直接喂参数）。
 * @param {{
 *   enabled?: boolean,
 *   busy?: boolean,
 *   privateOnly?: boolean,
 *   pinned?: string,
 *   targetId?: string,
 *   scope?: string,
 * }} input
 * @returns {{ok: boolean, reason: string}}
 */
export function checkForceGate(input = {}) {
  const {
    enabled = true,
    busy = false,
    privateOnly = true,
    pinned = '',
    targetId = '',
    scope,
  } = input;
  if (!enabled) return { ok: false, reason: '插件关了（enabled = false）' };
  if (busy) return { ok: false, reason: '上一拍还在跑，这一拍不排队（等它跑完再催一次）' };
  if (!targetId) return { ok: false, reason: '还没有目标会话（等用户在私聊里说一句，或配 targetSession）' };
  // 跟 ask() 一个口径：配置里写死的 targetSession 是用户显式指定，认不出也放行
  if (privateOnly && targetId !== pinned && !isDirectScope(scope)) {
    return { ok: false, reason: `目标会话不是私聊（${scope ?? '认不出'}）` };
  }
  return { ok: true };
}

/**
 * 真跑这一拍。调用方负责 gate 和互斥；这里只管跑、记账、写日志。
 * @param {{
 *   nowMs: number,
 *   state: object,
 *   cfg: object,
 *   log: (line: string) => void,
 *   runRound: (nowMs: number) => Promise<{ok: boolean, error?: string, action?: string}>,
 *   save?: () => void,
 *   recordSuccess?: (state: object) => void,
 *   recordFailure?: (state: object, nowMs: number, opts: object) => void,
 * }} deps
 */
export async function runForcedRound(deps) {
  const {
    nowMs,
    state,
    cfg = {},
    log = () => {},
    runRound,
    save = () => {},
    recordSuccess: onSuccess = recordSuccess,
    recordFailure: onFailure = recordFailure,
  } = deps;

  log('[debug] 手动催拍，跳过掷骰');
  log('[debug] debug 触发：跳过安静时段/峰价窗口与 nextRunAt 排期检查，正常排期不受影响');
  // 只记「真跑了」，不写 lastRollAt：这一拍根本没掷骰子
  state.lastRunAt = nowMs;

  let result;
  try {
    result = await runRound(nowMs);
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) };
  }
  if (result?.ok) {
    onSuccess(state);
    log(`[debug] 手动催拍成功（${result.action ?? '?'}），连败清零`);
  } else {
    onFailure(state, nowMs, { maxFailStreak: cfg.maxFailStreak, backoffMinutes: cfg.backoffMinutes });
    log(`[debug] 手动催拍失败：${result?.error || result?.detail || '未知'}｜连败 ${state.failStreak}`);
  }
  save();
  return result;
}

/**
 * 触发文件轮询器。
 * 看到文件 → 先删（删不掉就这轮不算，免得每 15 秒重跑同一拍）→ 再叫 onForce。
 * `stop()` 之后不再看文件，interval 也清掉。
 * @param {{
 *   filePath: string,
 *   intervalMs?: number,
 *   onForce?: () => void,
 *   log?: (line: string) => void,
 *   exists?: (p: string) => boolean,
 *   remove?: (p: string) => void,
 * }} options
 */
export function createForceWatcher(options = {}) {
  const {
    filePath,
    intervalMs = DEFAULT_FORCE_INTERVAL_MS,
    onForce,
    log = () => {},
    exists = (p) => fs.existsSync(p),
    remove = (p) => fs.rmSync(p, { force: true }),
  } = options;

  let stopped = false;
  let handle;

  function check() {
    if (stopped || !filePath) return false;
    if (!exists(filePath)) return false;
    try {
      remove(filePath);
    } catch (error) {
      log(`[debug] 催拍文件 ${filePath} 删不掉，这轮不催：${String(error?.message ?? error)}`);
      return false;
    }
    log(`[debug] 看到催拍文件 ${filePath}，已删除`);
    if (stopped) return false;
    try {
      onForce?.();
    } catch (error) {
      log(`[debug] 催拍回调抛错：${String(error?.message ?? error)}`);
    }
    return true;
  }

  function start() {
    if (handle || stopped) return;
    // 15 秒一次，unref：别拿这个轮询拽着进程不让退出
    handle = setInterval(check, intervalMs);
    if (typeof handle?.unref === 'function') handle.unref();
  }

  function stop() {
    stopped = true;
    if (handle) clearInterval(handle);
    handle = undefined;
  }

  return {
    start,
    stop,
    check,
    get stopped() {
      return stopped;
    },
  };
}
