/**
 * 想法重放：拿落盘的一条 stage2 方案（plans.jsonl 一行），按**当前** gate 规则原地重跑一遍。
 *
 * 用途只有一个：改 gate 之前先跑回归。以前改完 GA10 想知道「刚才被误伤的那条 plan 现在过不过」，
 * 只能等下一拍随机产出类似想法——120~250 秒一次、还未必撞上。现在旧 plan 就在盘上（lib/plans-log.js），
 * 这里把它读回来直接过一遍 `createGate().checkPlan`，前后 ga_hits 一比就知道是变好还是变坏。
 *
 * 默认不调模型、不写任何文件、不动 state：gate 是纯规则，veto 是纯查表（台账由调用方传进来）。
 * 传了 `arbiter` 才多跑第三段（灰色条目交 arbiter 判），这一步会真调模型、会产生费用。
 * GA3/GA4 要读盘的那半默认不跑（不传 deps 就记 unsupported），GA14 白名单默认空表，
 * 这两项在 notes 里看得出来，别把「未核」当成「合格」。
 */
import fs from 'node:fs';
import { mergeArbiterVerdicts, runArbiter } from './arbiter.js';
import { GA_HIT_KINDS, createGate } from './gate.js';
import { PAIR_SET } from './grid.js';
import { checkVeto } from './veto.js';
import { isPeak } from './window.js';

/** 处置严重度：拒 > 降级 > 未核（未核只是没验，不算坏） */
const RANK = Object.freeze({ reject: 3, downgrade: 2, unsupported: 1 });

/** 落盘记录里的候选 → gate 认的候选形状（id 用 pick；单段读 action 为 null） */
export function candidateFromRecord(record) {
  const one = record?.candidate;
  if (!one || typeof one !== 'object') return null;
  const cell = (c) => (c && typeof c === 'object'
    ? {
        primitive: String(c.primitive ?? ''),
        primitiveKey: String(c.primitiveKey ?? c.primitive ?? ''),
        objectKind: String(c.objectKind ?? ''),
        objectKey: String(c.objectKey ?? c.objectKind ?? ''),
      }
    : null);
  const read = cell(one.read);
  const action = one.action ? cell(one.action) : null;
  if (!read) return null;
  return {
    id: String(one.pick ?? record?.plan?.pick ?? ''),
    read,
    action,
    material: String(one.seed ?? ''),
    motivation: String(one.motivation ?? ''),
  };
}

/** verdict → `{ga, action, why}` 摊平，跟落盘那份 gate 字段同一口径 */
export function verdictItems(verdict) {
  const items = [];
  for (const kind of GA_HIT_KINDS) {
    const list = Array.isArray(verdict?.[kind]) ? verdict[kind] : [];
    for (const hit of list) {
      items.push({ ga: String(hit?.ga ?? '').trim() || 'GA?', action: kind, why: String(hit?.why ?? '') });
    }
  }
  return items;
}

/**
 * gate 判不了的灰色条目（`unsure`）落成 unsupported 明细。
 *
 * 不跑 arbiter 时它们是「没验」，不是「合格」；以前 `verdictItems` 只认 GA_HIT_KINDS，
 * 这批条目在重放结果里直接消失，调用方连「有过灰色条目」都看不见。现在显式记成
 * unsupported（不参与变好/变坏比较），arbiter 没开时也留痕。
 */
function unsureAsUnsupported(verdict) {
  const list = Array.isArray(verdict?.unsure) ? verdict.unsure : [];
  return list
    .filter((one) => one && typeof one === 'object')
    .map((one) => ({
      ga: String(one.ga ?? '').trim() || 'GA?',
      action: 'unsupported',
      why: String(one.why ?? ''),
    }));
}

/**
 * arbiter 要看的那一小段方案，口径跟 rewrite.js 的 `arbiterCtxOf` 一致：
 * 点子 / why / object / anchor / 第一步读什么 / 要改什么 / 文件 / 素材。
 */
function arbiterCtxOf(record) {
  const plan = record?.plan ?? {};
  const candidate = record?.candidate ?? {};
  const files = Array.isArray(plan?.plan?.files) ? plan.plan.files : [];
  return {
    candidateId: String(candidate?.pick ?? plan?.pick ?? '').trim(),
    idea: plan?.idea,
    why: plan?.why,
    object: plan?.object,
    anchor: plan?.object?.anchor,
    step1: plan?.step1,
    step2: plan?.step2,
    files,
    material: String(candidate?.seed ?? ''),
  };
}

/** runArbiter 的返回 → 重放返回里的 `arbiter` 字段（五个数：送了几条、判了什么、失败没） */
function arbiterReportOf(result, unsureCount) {
  const verdicts = Array.isArray(result?.verdicts) ? result.verdicts : [];
  return {
    cases: Number(result?.total) || unsureCount,
    sent: Number.isFinite(Number(result?.sent)) ? Number(result.sent) : 0,
    skipped: Math.max(0, Number(result?.skipped) || 0),
    verdicts,
    failed: result?.failed ? String(result.failed) : null,
  };
}

/** 按 ga 收口，只留最重的那条（同一关可能既拒又降级，比较时只认最重） */
function byGa(items) {
  const map = new Map();
  for (const one of Array.isArray(items) ? items : []) {
    const ga = String(one?.ga ?? '').trim() || 'GA?';
    const action = String(one?.action ?? '');
    const current = map.get(ga);
    if (!current || (RANK[action] ?? 0) > (RANK[current.action] ?? 0)) {
      map.set(ga, { ga, action, why: String(one?.why ?? '') });
    }
  }
  return map;
}

/** 拒 / 降级各几条：比较「变好/变坏」只看这两档，未核不算坏 */
function burden(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    reject: list.filter((one) => one?.action === 'reject').length,
    downgrade: list.filter((one) => one?.action === 'downgrade').length,
  };
}

function vetoField(record, vetoEnabled) {
  if (!vetoEnabled) return { ok: true, hit: null, ran: false };
  const raw = record?.veto;
  if (!raw || typeof raw !== 'object') return { ok: true, hit: null, ran: false };
  return { ok: raw.ok !== false, hit: raw.hit ?? null, ran: raw.ran !== false };
}

/** 重放时若带了台账，就按当前口径再查一次否决（纯查表，不写） */
function vetoPlanFrom(record) {
  const plan = record?.plan ?? {};
  const candidate = record?.candidate ?? {};
  const files = Array.isArray(plan?.plan?.files) ? plan.plan.files : [];
  return {
    comboKey: String(record?.comboKey ?? ''),
    objectNames: [plan?.object?.value, ...files]
      .map((one) => String(one ?? '').trim())
      .filter(Boolean),
    readPrimitive: String(candidate?.read?.primitive ?? '').trim(),
    objectKind: String(candidate?.action?.objectKind ?? candidate?.read?.objectKind ?? plan?.object?.kind ?? '').trim(),
    actionPrimitive: String(candidate?.action?.primitive ?? '').trim(),
    brief: '',
  };
}

/**
 * 重放一条记录。
 *
 * @param {object} record plans.jsonl 的一行（lib/plans-log.js 的 buildPlanRecord 输出）
 * @param {{
 *   vetoEnabled?: boolean,   // false = 不看否决台账（只看 gate）
 *   nowMs?: number,          // 重放时刻（veto 60 天窗口用；不传用当前时间）
 *   ledger?: object|null,    // 传了就按当前台账再查一次 veto
 *   deps?: object,           // GA3/GA4/GA5 的读盘实现（exists.js）；不传记 unsupported
 *   pairs?: Set<string>,     // 配对矩阵，默认 grid 的 PAIR_SET
 *   enabled?: {primitives?: object, objects?: object},
 *   peak?: boolean,          // 不传就按记录 ts 现算峰价
 *   holidays?: string[],
 *   previousMaterial?: string,
 *   outboundTargets?: string[],
 *   checkPlan?: (plan: object, context: object) => Promise<object>,  // 单测注入用
 *   arbiter?: ((prompt: string) => Promise<{ok: boolean, text?: string, error?: string}>)|null,
 *     // 已构造好的 agent 客户端；不传就不跑 arbiter（老行为，免费）
 *   arbiterConfig?: {maxCases?: number, timeoutMs?: number},
 *     // 跟 arbiter.js 的 runArbiter 同一套（maxCases 走 selectArbiterCases 的截断规则）
 * }} [opts]
 * @returns {Promise<{
 *   before: Array<{ga: string, action: string, why: string}>,
 *   after: Array<{ga: string, action: string, why: string}>,
 *   changed: 'better'|'same'|'worse',
 *   notes: string[],
 *   veto: {before: object, after: object},
 *   pass: {before: boolean, after: boolean},
 *   arbiter: null|{cases: number, sent: number, skipped: number,
 *     verdicts: Array<{ga: string, decision: string, why: string}>, failed: string|null},
 *     // null = 这次没跑 arbiter（没传客户端）；对象 = 跑了（cases:0 表示没有灰色条目白跑一趟）
 *   ts: number, comboKey: string, round: number,
 * }>}
 */
export async function replayPlan(record, opts = {}) {
  const {
    vetoEnabled = true,
    nowMs = Date.now(),
    ledger = null,
    deps = undefined,
    pairs = PAIR_SET,
    enabled = undefined,
    peak = undefined,
    holidays = [],
    previousMaterial = '',
    outboundTargets = [],
    checkPlan = null,
    arbiter = null,
    arbiterConfig = null,
  } = opts ?? {};
  const arbiterAgent = typeof arbiter === 'function' ? arbiter : null;

  const plan = record?.plan;
  const before = Array.isArray(record?.gate?.items) ? record.gate.items.map((one) => ({
    ga: String(one?.ga ?? '').trim() || 'GA?',
    action: String(one?.action ?? ''),
    why: String(one?.why ?? ''),
  })) : [];
  const beforeVeto = vetoField(record, vetoEnabled);

  if (!plan || typeof plan !== 'object') {
    return {
      before,
      after: before,
      changed: 'same',
      notes: ['记录里没有 plan 原文，重放不了'],
      veto: { before: beforeVeto, after: beforeVeto },
      pass: { before: false, after: false },
      arbiter: null,
      ts: Number(record?.ts) || 0,
      comboKey: String(record?.comboKey ?? ''),
      round: Number(record?.round) || 0,
    };
  }

  const candidate = candidateFromRecord(record);
  const context = {
    candidates: candidate ? [candidate] : [],
    pairs,
    enabled,
    peak: peak === undefined ? isPeak(new Date(Number(record?.ts) || nowMs), holidays) : Boolean(peak),
    previousMaterial,
    // 单段读全拍只许一格：记录里这一格没有动作格就是单段
    singleReadCount: candidate && !candidate.action ? 1 : 0,
    outboundTargets,
  };

  let verdict;
  try {
    const run = typeof checkPlan === 'function'
      ? checkPlan
      : (one, ctx) => createGate({ deps: deps ?? {} }).checkPlan(one, ctx);
    verdict = await run(plan, context);
  } catch (error) {
    return {
      before,
      after: [],
      changed: 'same',
      notes: [`重放跑挂了（gate 抛错）：${String(error?.message ?? error)}`],
      veto: { before: beforeVeto, after: beforeVeto },
      pass: { before: false, after: false },
      arbiter: null,
      ts: Number(record?.ts) || 0,
      comboKey: String(record?.comboKey ?? ''),
      round: Number(record?.round) || 0,
    };
  }

  let after = verdictItems(verdict);
  let afterVeto = beforeVeto;
  if (vetoEnabled && ledger) {
    try {
      const found = checkVeto(vetoPlanFrom(record), ledger, { now: nowMs });
      afterVeto = { ok: found?.ok !== false, hit: found?.hit ?? null, ran: true };
    } catch (error) {
      afterVeto = { ...beforeVeto, error: String(error?.message ?? error) };
    }
  }

  /*
   * 第三段 arbiter：只有 gate 没拒、veto 没拦、而且 gate 真留了灰色条目（unsure）才送。
   * 顺序跟真实链路一样（gate → veto → arbiter），前面两关先收工的不白花一次模型调用。
   * 传了 arbiter 就一定回一个对象（哪怕 0 条），没传才是 null——调用方别把「没跑」和
   * 「跑了但没命中」混起来。
   */
  const unsure = Array.isArray(verdict?.unsure) ? verdict.unsure : [];
  const gateVetoPass = burden(after).reject === 0 && afterVeto.ok;
  let arbiterReport = arbiterAgent
    ? { cases: 0, sent: 0, skipped: 0, verdicts: [], failed: null }
    : null;
  if (arbiterAgent && gateVetoPass && unsure.length > 0) {
    let result;
    try {
      result = await runArbiter({
        cases: unsure,
        ctx: arbiterCtxOf(record),
        agent: arbiterAgent,
        config: arbiterConfig ?? {},
      });
    } catch (error) {
      // runArbiter 自己兜住 agent 抛错；这里再兜一层，绝不让 arbiter 把重放带塌
      result = {
        verdicts: [],
        failed: `调用失败：${String(error?.message ?? error)}`,
        total: unsure.length,
        sent: 0,
        skipped: 0,
      };
    }
    const merged = mergeArbiterVerdicts({ verdict, verdicts: result?.verdicts ?? [] });
    after = verdictItems(merged.verdict);
    arbiterReport = arbiterReportOf(result, unsure.length);
  } else {
    // 没跑 arbiter：unsure 按 unsupported 记下（没验不等于合格，但也不参与变好/变坏比较）
    after = [...after, ...unsureAsUnsupported(verdict)];
  }

  const bBurden = burden(before);
  const aBurden = burden(after);
  const beforeRejected = bBurden.reject > 0;
  const afterRejected = aBurden.reject > 0;
  const passBefore = !beforeRejected && beforeVeto.ok;
  const passAfter = !afterRejected && afterVeto.ok;

  let changed;
  if (passBefore !== passAfter) {
    changed = passAfter ? 'better' : 'worse';
  } else if (aBurden.reject < bBurden.reject
    || (aBurden.reject === bBurden.reject && aBurden.downgrade < bBurden.downgrade)) {
    changed = 'better';
  } else if (aBurden.reject > bBurden.reject
    || (aBurden.reject === bBurden.reject && aBurden.downgrade > bBurden.downgrade)) {
    changed = 'worse';
  } else {
    changed = 'same';
  }

  // notes 给 CLI 直接拼人话：消失的关、新冒出来的关、改档的关
  const notes = [];
  const oldMap = byGa(before);
  const newMap = byGa(after);
  for (const [ga, one] of oldMap) {
    if (one.action === 'unsupported') continue;
    const now = newMap.get(ga);
    if (!now || now.action === 'unsupported') {
      notes.push(`${ga} 不再命中（旧：${one.why || '没写原因'}）`);
    } else if (now.action !== one.action) {
      notes.push(`${ga} 从${one.action}变成${now.action}（${now.why || '没写原因'}）`);
    }
  }
  for (const [ga, one] of newMap) {
    if (one.action === 'unsupported') continue;
    const old = oldMap.get(ga);
    if (!old || old.action === 'unsupported') notes.push(`新命中 ${ga}：${one.why || '没写原因'}`);
  }
  if (beforeVeto.ok !== afterVeto.ok) {
    notes.push(afterVeto.ok ? 'veto 不再拦' : 'veto 现在会拦');
  }
  if (notes.length === 0) notes.push('ga_hits 没变');

  return {
    before,
    after,
    changed,
    notes,
    veto: { before: beforeVeto, after: afterVeto },
    pass: { before: passBefore, after: passAfter },
    arbiter: arbiterReport,
    ts: Number(record?.ts) || 0,
    comboKey: String(record?.comboKey ?? ''),
    round: Number(record?.round) || 0,
  };
}

/** `YYYY-MM-DD` 按本地日算；给数字/Date 直接用；给到日界（until 含当天整天） */
function toMs(value, { endOfDay = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 0, 0, 0, 0);
    if (endOfDay) d.setHours(23, 59, 59, 999);
    return d.getTime();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 一行 JSONL 里有没有历史命中过这条 GA */
function hitGa(record, ga) {
  if (!ga) return true;
  const want = String(ga).trim().toUpperCase();
  const items = Array.isArray(record?.gate?.items) ? record.gate.items : [];
  if (items.some((one) => String(one?.ga ?? '').trim().toUpperCase() === want)) return true;
  const hits = Array.isArray(record?.gate?.hits) ? record.gate.hits : [];
  return hits.some((one) => String(one ?? '').trim().toUpperCase() === want);
}

/**
 * 读一份 jsonl，逐条重放。
 *
 * @param {string} file
 * @param {{
 *   since?: string|number|Date, until?: string|number|Date, limit?: number,
 *   ga?: string, onlyChanged?: boolean, readFile?: Function, log?: Function,
 *   ...replayOptions
 * }} [opts] 其余字段原样交给 replayPlan（vetoEnabled / nowMs / ledger / deps / arbiter …）
 * @returns {Promise<{file: string, total: number, better: number, same: number, worse: number,
 *   scanned: number, skipped: number,
 *   arbiter: null|{cases: number, sent: number, skipped: number,
 *     pass: number, reject: number, downgrade: number, failed: number},
 *   items: Array<object>}>}
 */
export async function replayFile(file, opts = {}) {
  const {
    since = null,
    until = null,
    limit = 50,
    ga = '',
    onlyChanged = false,
    readFile = fs.readFileSync,
    log = () => {},
    ...replayOptions
  } = opts ?? {};

  let text = '';
  try {
    text = String(readFile(file, 'utf8') ?? '');
  } catch (error) {
    const err = new Error(`读不到落盘文件 ${file}：${String(error?.message ?? error)}`);
    err.code = error?.code ?? 'EREAD';
    throw err;
  }

  const sinceMs = toMs(since);
  const untilMs = toMs(until, { endOfDay: true });
  const max = Number(limit);
  const limitN = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;

  const picked = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const ts = Number(record?.ts);
    if (!Number.isFinite(ts) || ts <= 0) {
      skipped += 1;
      continue;
    }
    if (sinceMs !== null && ts < sinceMs) continue;
    if (untilMs !== null && ts > untilMs) continue;
    if (!hitGa(record, ga)) continue;
    picked.push(record);
  }
  // limit 取最近 N 条（文件是 append-only，越靠后越新），重放顺序仍按文件顺序
  const window = limitN > 0 ? picked.slice(-limitN) : picked;

  const items = [];
  // 汇总按「跑过的全部记录」算，--changed 滤掉的那些也算，别少报送出去的条数
  const arbiterReports = [];
  for (const record of window) {
    try {
      const one = await replayPlan(record, { ...replayOptions, nowMs: replayOptions.nowMs ?? Date.now() });
      if (one.arbiter) arbiterReports.push(one.arbiter);
      if (onlyChanged && one.changed === 'same') continue;
      items.push(one);
    } catch (error) {
      skipped += 1;
      log(`replay_fail:${String(error?.message ?? error)}`);
    }
  }

  return {
    file,
    total: items.length,
    better: items.filter((one) => one.changed === 'better').length,
    same: items.filter((one) => one.changed === 'same').length,
    worse: items.filter((one) => one.changed === 'worse').length,
    scanned: window.length,
    skipped,
    // 没传 arbiter 就是 null（跟 replayPlan 一个口径）；传了就算个总账给汇总行用
    arbiter: typeof replayOptions.arbiter === 'function' ? summarizeArbiter(arbiterReports) : null,
    items,
  };
}

/** 整份重放里 arbiter 干了多少活：送几条、判了几档、几段调用失败 */
function summarizeArbiter(reports) {
  const out = { cases: 0, sent: 0, skipped: 0, pass: 0, reject: 0, downgrade: 0, failed: 0 };
  for (const one of Array.isArray(reports) ? reports : []) {
    if (!one) continue;
    out.cases += Number(one.cases) || 0;
    out.sent += Number(one.sent) || 0;
    out.skipped += Number(one.skipped) || 0;
    if (one.failed) out.failed += 1;
    for (const judgment of Array.isArray(one.verdicts) ? one.verdicts : []) {
      const decision = String(judgment?.decision ?? '').trim().toLowerCase();
      if (decision === 'pass' || decision === 'reject' || decision === 'downgrade') out[decision] += 1;
    }
  }
  return out;
}
