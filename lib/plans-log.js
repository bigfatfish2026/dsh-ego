/**
 * stage2 方案的落盘（一行一条 JSONL），给 gate 回归用。
 *
 * 为什么要留：方案正文以前只在日志里剩一句 `ga_hits` 摘要，改完 gate 想验「刚才被误伤
 * 的那条 plan 现在过不过」，只能等下一拍随机再产出类似想法——烧 120~250 秒和钱，还不一定撞上。
 * 现在每版 stage2 方案（gate 拒 / veto 拒 / abort / 空拍 / 重写 / 拍板）都落一行，
 * 事后用 lib/replay.js 拿旧 plan 原地重跑一遍。
 *
 * 三条硬约束：
 *   1. 落盘绝不能影响裁决：序列化、轮转、append 全包在 try/catch 里，失败只记一行日志；
 *   2. 一行一份 plan，绝不合并；append 用 appendFileSync（O_APPEND），单行一次写；
 *   3. 写前脱敏：走 veto 台账那份 mask（sk- / ghp_ / github_pat_ / gho_ / ghu_ / ghs_ /
 *      ghr_ / crsr_ / oc_ 全覆盖），按字符串值递归遮，遮完仍是合法 JSON。
 *
 * 轮转：append 前看一眼，文件超过 20MB 或超过 3000 行就改名成 `.1`（覆盖旧的 .1）。
 * 行数不每次全量数：按 stat.size 命中进程内缓存，缓存对不上（重启、外部写过）才重数一遍。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GA_HIT_KINDS } from './gate.js';
import { redactVetoText } from './veto.js';

/** 默认落盘路径：`DSH_EGO_PLANS_PATH` 可覆盖，配置项 plansPath 优先于这个默认值 */
export const DEFAULT_PLANS_PATH = process.env.DSH_EGO_PLANS_PATH
  || path.join(os.homedir(), '.dsh-ego', 'plans.jsonl');
export const PLANS_MAX_BYTES = 20 * 1024 * 1024;
export const PLANS_MAX_LINES = 3000;

/** `file -> {size, lines}`：只在 append/轮转时维护，别处不要读 */
const lineCache = new Map();

/** 字符串值递归过一遍 mask；对象/数组保持形状，数字/布尔/null 原样 */
export function maskSecrets(value) {
  if (typeof value === 'string') return redactVetoText(value);
  if (Array.isArray(value)) return value.map((one) => maskSecrets(one));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = maskSecrets(item);
    return out;
  }
  return value;
}

/** 一格候选摊成落盘用的浅形状：编号 + 读/动作的原语×对象 + 动机 + 种子 */
function candidateField(candidate, plan) {
  const cell = (one) => (one
    ? {
        primitive: String(one.primitive ?? ''),
        primitiveKey: String(one.primitiveKey ?? ''),
        objectKind: String(one.objectKind ?? ''),
        objectKey: String(one.objectKey ?? ''),
      }
    : null);
  return {
    pick: String(plan?.pick ?? candidate?.id ?? ''),
    read: cell(candidate?.read),
    action: candidate?.action ? cell(candidate.action) : null,
    motivation: String(candidate?.motivation ?? ''),
    seed: String(candidate?.material ?? ''),
  };
}

/**
 * 把 gate 的 verdict 摊成 `{ga, action, why}`（action = reject / downgrade / unsupported，全量）。
 * @param {object} verdict
 * @returns {{ok: boolean, allowDo: boolean, hits: string[], items: Array<{ga: string, action: string, why: string}>}}
 */
export function gateField(verdict) {
  const items = [];
  for (const kind of GA_HIT_KINDS) {
    const list = Array.isArray(verdict?.[kind]) ? verdict[kind] : [];
    for (const hit of list) {
      items.push({
        ga: String(hit?.ga ?? '').trim() || 'GA?',
        action: kind,
        why: String(hit?.why ?? ''),
      });
    }
  }
  return {
    ok: Boolean(verdict?.ok),
    allowDo: Boolean(verdict?.allowDo),
    hits: (Array.isArray(verdict?.hits) ? verdict.hits : []).map(String),
    items,
  };
}

/**
 * 拼一条落盘记录。字段固定在票面那一份，多一个 `outcome` 只为事后分拣（不放宽任何判定）。
 *
 * @param {{
 *   ts?: number, callId?: string, comboKey?: string, candidate?: object, plan?: object,
 *   verdict?: object|null, veto?: {ok: boolean, hit: unknown}|null,
 *   judge?: {action?: string, reason?: string}|null, outcome?: string, round?: number,
 *   gridSeed?: number,
 * }} input
 * @returns {object}
 */
export function buildPlanRecord({
  ts = Date.now(),
  callId = '',
  comboKey = '',
  candidate = null,
  plan = null,
  verdict = null,
  veto = null,
  judge = null,
  outcome = '',
  round = 0,
  gridSeed = 0,
} = {}) {
  return {
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
    callId: String(callId ?? ''),
    comboKey: String(comboKey ?? ''),
    candidate: candidateField(candidate, plan),
    // 方案原文：完整 JSON 对象，不截断（只过 mask）
    plan: plan ?? null,
    gate: gateField(verdict),
    veto: veto
      ? { ok: Boolean(veto.ok), hit: veto.hit ?? null, ran: veto.ran !== false }
      : null,
    judge: judge
      ? { action: String(judge.action ?? ''), reason: String(judge.reason ?? '') }
      : null,
    outcome: String(outcome ?? ''),
    round: Number.isFinite(Number(round)) ? Number(round) : 0,
    // stage1 加权抽取的 seed：同一行里带着，事后重放这一拍就能复现抽到哪一格
    gridSeed: Number.isFinite(Number(gridSeed)) ? Number(gridSeed) : 0,
  };
}

/** 数一份文件里有几行（末尾没换行的那行也算一行） */
export function countLines(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
  if (!text) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/**
 * 轮转判断：append 前看一眼，超 20MB 或超 3000 行就把当前文件改名成 `.1`（覆盖旧的）。
 * 拿不到文件（还没写过）就当不用轮转。
 *
 * @param {{
 *   file?: string, maxBytes?: number, maxLines?: number,
 *   statFile?: Function, readFile?: Function, rename?: Function, log?: Function,
 * }} [options]
 * @returns {{rotated: boolean, lines: number, size: number}}
 */
export function maybeRotate({
  file = DEFAULT_PLANS_PATH,
  maxBytes = PLANS_MAX_BYTES,
  maxLines = PLANS_MAX_LINES,
  statFile = fs.statSync,
  readFile = fs.readFileSync,
  rename = fs.renameSync,
  log = () => {},
} = {}) {
  let stat;
  try {
    stat = statFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      lineCache.set(file, { size: 0, lines: 0 });
      return { rotated: false, lines: 0, size: 0 };
    }
    // stat 不了（权限、路径类型不对）也不拦落盘：下面 append 自己会失败并记一行
    log(`plans_log_stat_fail:${error?.message ?? error}`);
    return { rotated: false, lines: 0, size: 0 };
  }
  const size = Number(stat?.size) || 0;
  if (size === 0) {
    lineCache.set(file, { size: 0, lines: 0 });
    return { rotated: false, lines: 0, size: 0 };
  }
  const cached = lineCache.get(file);
  let lines;
  if (cached && cached.size === size) {
    lines = cached.lines;
  } else {
    try {
      lines = countLines(readFile(file));
    } catch (error) {
      log(`plans_log_count_fail:${error?.message ?? error}`);
      lines = cached?.lines ?? 0;
    }
    lineCache.set(file, { size, lines });
  }
  if (size > maxBytes || lines > maxLines) {
    try {
      // rename 覆盖旧的 .1：POSIX 上就是原子替换，不先 unlink
      rename(file, `${file}.1`);
      lineCache.set(file, { size: 0, lines: 0 });
      log(`plans_log_rotate:${size}B｜${lines} 行→${file}.1`);
      return { rotated: true, lines: 0, size: 0 };
    } catch (error) {
      log(`plans_log_rotate_fail:${error?.message ?? error}`);
      return { rotated: false, lines, size };
    }
  }
  return { rotated: false, lines, size };
}

/**
 * 追加一行。永不抛：序列化/轮转/写盘任一步失败都只 log 一行然后返回 `{ok:false}`，
 * 调用方（rewrite 循环）照旧往下裁决。
 *
 * @param {object} record buildPlanRecord 的输出
 * @param {{
 *   file?: string, maxBytes?: number, maxLines?: number,
 *   appendFile?: Function, statFile?: Function, readFile?: Function, rename?: Function,
 *   mkdir?: Function, log?: Function,
 * }} [options]
 * @returns {{ok: boolean, bytes: number, error?: string}}
 */
export function appendPlan(record, options = {}) {
  const {
    file = DEFAULT_PLANS_PATH,
    maxBytes = PLANS_MAX_BYTES,
    maxLines = PLANS_MAX_LINES,
    appendFile = fs.appendFileSync,
    statFile = fs.statSync,
    readFile = fs.readFileSync,
    rename = fs.renameSync,
    mkdir = fs.mkdirSync,
    log = () => {},
  } = options;

  let line;
  try {
    line = `${JSON.stringify(maskSecrets(record))}\n`;
  } catch (error) {
    log(`plans_log_fail:序列化失败｜${error?.message ?? error}`);
    return { ok: false, bytes: 0, error: String(error?.message ?? error) };
  }
  const bytes = Buffer.byteLength(line, 'utf8');

  // 目录不在就补一个（换机器、换路径时省得第一次全失败）；失败也交给下面 append 记一行
  try {
    mkdir(path.dirname(file), { recursive: true });
  } catch (error) {
    log(`plans_log_mkdir_fail:${error?.message ?? error}`);
  }

  maybeRotate({ file, maxBytes, maxLines, statFile, readFile, rename, log });

  try {
    // appendFileSync = O_APPEND + 一次 write，单行落盘不跟别的写者交错
    appendFile(file, line, 'utf8');
    const cached = lineCache.get(file) ?? { size: 0, lines: 0 };
    lineCache.set(file, { size: cached.size + bytes, lines: cached.lines + 1 });
    return { ok: true, bytes };
  } catch (error) {
    log(`plans_log_fail:${file}｜${error?.message ?? error}`);
    return { ok: false, bytes: 0, error: String(error?.message ?? error) };
  }
}
