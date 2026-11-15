/**
 * 手动催一拍（ego_tick 工具 + touch 文件那条老路共用）。
 *
 * 两种入口走同一套语义：
 *   · 跳过骰子、安静时段、峰价窗口、nextRunAt 排期；
 *   · privateOnly / 目标会话 / 互斥照旧；
 *   · 这一拍是额外补跑，**不动** failStreak / retryAfterAt / nextRunAt。
 *     touch 老路保持原行为（成功清零连败、失败 +1）；ego_tick 传 account=false，
 *     两次记账都换成空函数，只跑、只记 lastRunAt。
 *
 * 单独拆出来是因为 lib/index.js 静态 import 了宿主依赖，`node --test` 里 import 不了；
 * 这里只依赖 node 内置和 force.js，单测能把「不并发、不改排期」真跑一遍。
 */
import { checkForceGate, runForcedRound } from './force.js';

/** 日志里 reason 一栏上限：默认日志单行能长，但催拍原因没必要几百字。 */
export const TICK_REASON_MAX = 120;

/**
 * 建一个「立刻跑一拍」的触发器。互斥状态由调用方持有（index.js 的 ticking），
 * 这样手动催拍和整点拍、兜底轮询共用同一把锁。
 *
 * @param {{
 *   state: object,
 *   cfg: object,
 *   targetId: () => string,
 *   scopeOf: (id: string) => string|undefined,
 *   isBusy: () => boolean,
 *   setBusy: (busy: boolean) => void,
 *   runRound: (nowMs: number) => Promise<object>,
 *   save: () => void,
 *   log?: (line: string) => void,
 *   getDryRunOverride?: () => boolean|null,
 *   setDryRunOverride?: (value: boolean|null) => void,
 * }} deps
 */
export function createManualTick(deps) {
  const {
    state,
    cfg,
    targetId,
    scopeOf,
    isBusy,
    setBusy,
    runRound,
    save,
    log = () => {},
    getDryRunOverride = () => null,
    setDryRunOverride = () => {},
  } = deps;

  /**
   * @param {number} [nowMs]
   * @param {{reason?: string, dryRun?: boolean, account?: boolean}} [options]
   *   dryRun 传 true/false 强制演练/真跑；不传（undefined）沿用配置。
   *   account=false 时不改 failStreak / retryAfterAt（ego_tick 用）。
   */
  return async function manualTick(nowMs = Date.now(), options = {}) {
    const { dryRun, account = true } = options;
    const id = targetId();
    const busy = Boolean(isBusy());
    const gate = checkForceGate({
      enabled: cfg.enabled,
      busy,
      privateOnly: cfg.privateOnly,
      pinned: String(cfg.targetSession || '').trim(),
      targetId: id,
      scope: scopeOf(id),
    });
    if (!gate.ok) {
      log(`[debug] 手动催拍被拒：${gate.reason}`);
      return { ok: false, error: gate.reason, rejected: true, busy };
    }

    setBusy(true);
    const prevOverride = getDryRunOverride();
    setDryRunOverride(typeof dryRun === 'boolean' ? dryRun : null);
    try {
      const nextBefore = state.nextRunAt;
      const result = await runForcedRound({
        nowMs,
        state,
        cfg,
        log,
        runRound,
        save,
        // 额外补跑不占正常拍的位：成功不清零连败、失败不推退避
        ...(account
          ? {}
          : {
              recordSuccess: () => {},
              recordFailure: () => {},
            }),
      });
      // 正常拍是 planNext(nowMs) 重排；手动拍刻意不动 nextRunAt
      if (state.nextRunAt !== nextBefore) {
        log(`[debug] nextRunAt 被改动了（${fmtTick(nextBefore)} → ${fmtTick(state.nextRunAt)}），手动拍不该这样，改回去`);
        state.nextRunAt = nextBefore;
        save();
      }
      return { ...result, dryRun: getDryRunOverride() ?? cfg.dryRun };
    } finally {
      setDryRunOverride(prevOverride);
      setBusy(false);
    }
  };
}

function fmtTick(t) {
  if (!t) return '—';
  const d = new Date(Number(t));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** reason 压成单行并按字符截断；没写就记「未写」。 */
export function normalizeTickReason(reason) {
  const one = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return '未写';
  return [...one].slice(0, TICK_REASON_MAX).join('');
}

/** 日志固定一行：ego_tick:手动催拍｜reason:…｜结果:…｜<耗时>ms */
export function formatTickLog({ reason, outcome, ms }) {
  const spent = Math.max(0, Math.round(Number(ms) || 0));
  return `ego_tick:手动催拍｜reason:${normalizeTickReason(reason)}｜结果:${outcome}｜${spent}ms`;
}

/** 落点归类：do / silent / ask / rewrite→X / veto / 失败 / 跳过。 */
export function classifyTickOutcome(result, { busy = false } = {}) {
  if (busy) return '跳过';
  if (!result || result.ok === false) return '失败';
  if (result.vetoRejected) return 'veto';
  const action = String(result.action ?? '');
  if (action === 'do' || action === 'ask' || action === 'silent' || action === 'skipped') {
    const shown = action === 'skipped' ? 'silent' : action;
    const rewrites = Math.max(0, Number(result.rewrites) || 0);
    return rewrites > 0 ? `rewrite→${shown}` : shown;
  }
  return '失败';
}

function seconds(ms) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(2)}s`;
}

function clipOne(value, max = 200) {
  return [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

/** 一句话摘要：落点、judge verdict、耗时秒数、失败原因（有才写）。 */
export function formatTickSummary({ outcome, verdict, ms, error = '', dry = false, busy = false }) {
  const parts = [`ego_tick：落点 ${outcome}`];
  if (busy) {
    parts.push('上一拍还在跑，跳过（不排队、不并发跑第二拍）');
    parts.push(`耗时 ${seconds(ms)}`);
    return parts.join('｜');
  }
  parts.push(`judge verdict ${verdict ? String(verdict) : '无'}`);
  if (dry) parts.push('演练（不发消息不开票）');
  parts.push(`耗时 ${seconds(ms)}`);
  const why = clipOne(error);
  if (why) parts.push(`失败原因：${why}`);
  return parts.join('｜');
}

export const EGO_TICK_DESCRIPTION =
  '立刻跑一拍 dsh-ego 主动念头（提议 → 裁决 → 落地），跳过随机数与排期，改完代码验效果用。'
  + '不是查询状态（查状态用 ego_status）：调用会真的跑一拍。'
  + 'reason 可选，记进日志说明这次为什么催；dryRun 可选，true 强制演练、false 强制真跑，不填沿用配置。'
  + '正在跑一拍时调用会直接返回「上一拍还在跑，跳过」，不排队、不并发跑两拍。';

/**
 * 工具执行体：只做参数归一、耗时、日志行、摘要，真跑交给注入的 manualTick。
 * @param {{
 *   manualTick: (nowMs: number, options: object) => Promise<object>,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   isBusy?: () => boolean,
 * }} deps
 */
export function createEgoTickTool(deps) {
  const { manualTick, log = () => {}, now = () => Date.now(), isBusy = () => false } = deps;

  return async function execute(args = {}) {
    const started = now();
    const busy = Boolean(isBusy());
    let result = null;
    if (!busy) {
      try {
        result = await manualTick(started, {
          reason: args?.reason,
          dryRun: typeof args?.dryRun === 'boolean' ? args.dryRun : undefined,
          // ego_tick 是额外补跑：不清连败、不推退避，不占正常拍的位
          account: false,
        });
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) };
      }
    }
    const ms = Math.max(0, now() - started);
    const outcome = classifyTickOutcome(result, { busy });
    const error = result && result.ok === false ? result.error || result.detail || '' : '';
    const verdict = result?.verdict ?? null;
    const summary = formatTickSummary({
      outcome,
      verdict,
      ms,
      error,
      dry: Boolean(result?.dryRun),
      busy,
    });
    log(formatTickLog({ reason: args?.reason, outcome, ms }));
    return summary;
  };
}
