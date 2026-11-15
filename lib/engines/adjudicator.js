/**
 * 裁决器引擎：终审（judge）+ 否决台账（veto）+ arbiter 第三关。
 *
 * 从 lib/index.js 的 apply 闭包里整段搬出来（行为零改动）：
 *   · judge 只看 idea/why 与整份 plan，结果过 gate.checkDecision / guardGoal；
 *   · veto 台账按 mtime + 字节数缓存，缓存与 reporter 都是本对象自己的字段；
 *   · arbiter 的现场对象也收在这里，由提议器在重写循环里取用。
 * 配置、状态、gate、ctx 由 deps 注入，纯函数与模块工具直接 import。
 */
import fs from 'node:fs';
import { checkVeto, createVetoLoadReporter, loadVeto, selectRecentVeto } from '../veto.js';
import { buildJudgePrompt } from '../judge.js';
import { guardGoal } from '../gate.js';
import { runAgent, routeOptions } from '../agent-run.js';
import { runArbiter } from '../arbiter.js';
import { clipText } from '../text.js';
import { comboKey } from '../combo.js';

/**
 * @param {object} deps
 * @param {object} deps.cfg 已合并默认值、已夹过预算的配置
 * @param {object} deps.state 插件内存 state
 * @param {Function} deps.log 单行日志
 * @param {object} deps.gate 校验层实例
 * @param {object} deps.ctx 宿主 ctx（建临时 agent 用）
 */
export function createAdjudicator(deps) {
  const { cfg, state, log, gate, ctx } = deps;

  async function judge(proposal, nowMs) {
    const section = cfg.judge;
    if (!section.enabled) return { ok: false, skipped: true, error: 'judge.enabled = false' };
    const prompt = buildJudgePrompt({
      idea: proposal.idea,
      why: proposal.why,
      // 整份 plan 都给它：step1.read / step2.change / step2.files / step2.undo / object
      plan: proposal,
      now: new Date(nowMs),
      state,
      lastReportAt: state.lastReportAt,
      lastAskAt: state.lastAskAt,
      // 规则第八节：最近 5 条被否方向只给 judge；规则关（veto）用不上自然语言
      recentVeto: cfg.vetoEnabled ? selectRecentVeto(getVetoLedger(nowMs), { now: nowMs }) : [],
      rules: {
        minChars: section.askMinChars,
        maxChars: section.askMaxChars,
        forbidden: section.forbiddenWords,
      },
    });
    const result = await runAgent(
      { create: (options) => ctx.agents.create(options), log },
      {
        kind: 'judge',
        prompt,
        allow: section.allow,
        timeoutMs: section.timeoutMs,
        agentPreset: 'dsh-ego-judge',
        // 终审预算走 section.maxTokens（apply 里已夹到 1000–8000，默认 4000）
        agentOptions: routeOptions(section),
      },
    );
    if (!result.ok) return { ok: false, error: `终审失败：${result.error}` };
    // ③ 裁决这一层：action 合法 / ask 文案五关 / do 的 goal 与 brief，全在 gate 里判
    // 整份 plan 一起给：ask 文案复述方案里写过的数字（文件名、行号、计数）要算有出处
    const report = gate.checkDecision(result.text, { idea: proposal.idea, why: proposal.why, plan: proposal });
    for (const one of report.warnings ?? []) log(`ask_number_warn:1｜${one}`);
    if (!report.ok) {
      const label = report.scope === 'ask' ? 'ask 文案' : report.scope === 'intent' ? 'intent 契约' : '终审回复';
      return {
        ok: false,
        error:
          `终审的回复不能当裁决｜被拦：${report.problems.join('；') || '未知原因'}` +
          `｜${label} ${report.len} 字符｜${clipText(report.text)}`,
      };
    }
    /*
     * goal 回写校验（开票前最后一道）：goal 里的路径要在 plan 的 step2.files /
     * object.value / step1.read 里出现过，行号区间要在 plan 原文里找得到。
     * 对不上就不采用终审的 goal，回退成 plan 的 idea + why 直接拼，日志留码。
     */
    const guarded = guardGoal(report.decision, proposal, { log, briefMaxColumns: gate.briefMaxColumns });
    return { ok: true, decision: guarded.decision };
  }

  // ── 否决台账（裁决器·第二道关）──────
  /*
   * 每拍按 mtime + 字节数缓存一次：主会话新写的一行不用等重启（规则第十二节）。
   * 文件不在 / 读坏 / 坏行都当空账，绝不把整拍卡死。
   * veto_load 打点只在真的重读时打（缓存命中直接走人），同一份文件反复读不重复刷日志。
   */
  let vetoCache = { key: undefined, ledger: null };
  const reportVetoLoad = createVetoLoadReporter({ log });

  function getVetoLedger(nowMs) {
    if (!cfg.vetoEnabled) {
      return { path: cfg.vetoPath, entries: [], byCombo: new Map(), byAction: new Map(), skipped: 0, mtimeMs: null, exists: false };
    }
    let mtimeMs = null;
    let bytes = null;
    try {
      const stat = fs.statSync(cfg.vetoPath);
      mtimeMs = stat.mtimeMs;
      bytes = stat.size;
    } catch {
      // 文件不在：空账，等它出现（mtime 变了）再重读
      mtimeMs = null;
      bytes = null;
    }
    const cacheKey = mtimeMs === null ? 'missing' : `${mtimeMs}:${bytes}`;
    if (vetoCache.ledger && vetoCache.key === cacheKey) return vetoCache.ledger;
    const ledger = loadVeto(cfg.vetoPath, { now: nowMs });
    // 读没读、读了几条进日志；打点自己坏了也只静默跳过（reporter 内部 try/catch）
    reportVetoLoad(ledger, { bytes });
    if (ledger.skipped > 0) log(`veto_skip:${ledger.skipped}｜台账里有认不出的行，跳过（不拒）`);
    vetoCache = { key: cacheKey, ledger };
    return ledger;
  }

  /**
   * 这一版方案对应的台账判据：comboKey 只到格对（对象名另列），
   * objectNames 取 object.value + plan.files，跟写入侧口径一致（规则第四、十二节）。
   */
  function vetoPlanFrom(proposal) {
    const candidate = proposal?.candidate;
    const files = Array.isArray(proposal?.plan?.files) ? proposal.plan.files : [];
    return {
      comboKey: comboKey(candidate),
      objectNames: [proposal?.object?.value, ...files]
        .map((one) => String(one ?? '').trim())
        .filter(Boolean),
      readPrimitive: String(candidate?.read?.primitive ?? '').trim(),
      objectKind: String(candidate?.action?.objectKind ?? candidate?.read?.objectKind ?? proposal?.object?.kind ?? '').trim(),
      actionPrimitive: String(candidate?.action?.primitive ?? '').trim(),
      brief: '',
    };
  }

  /** gate 之后、judge 之前查台账；日志跟 gate 分开（veto_hit / veto_escalate）。 */
  function checkVetoFor(proposal, nowMs) {
    if (!cfg.vetoEnabled) return { ok: true, reason: '', hit: null };
    const plan = vetoPlanFrom(proposal);
    const verdict = checkVeto(plan, getVetoLedger(nowMs), { now: nowMs });
    if (!verdict.ok && verdict.hit) {
      const hit = verdict.hit;
      const ts = Number.isFinite(hit.ts) ? new Date(hit.ts).toISOString() : '（没记时间）';
      log(`veto_hit:${hit.rule}｜${plan.comboKey}｜${hit.objectName || plan.objectNames[0] || '（没对象）'}｜${ts}`);
      if (hit.rule === 'escalate') {
        log(`veto_escalate:${plan.objectKind}|${plan.actionPrimitive}｜${hit.count} 次｜${ts}`);
      }
    }
    return verdict;
  }

  /*
   * arbiter 关（第三道关）：gate 判不了的灰色条目打包给一只轻量 agent 逐条判。
   * 建一次就够：配置在 apply 里已经定了，对象本身无状态。
   */
  const arbiter = cfg.arbiter.enabled ? {
    enabled: true,
    run: (cases, arbiterCtx) => runArbiter({
      cases,
      ctx: arbiterCtx,
      config: cfg.arbiter,
      agent: (prompt) => runAgent(
        { create: (options) => ctx.agents.create(options), log },
        {
          kind: 'arbiter',
          prompt,
          // 只读：让它能看一眼文件，但判定只以 JSON 回来，动作归 judge 和 dispatcher
          allow: cfg.arbiter.allow,
          timeoutMs: cfg.arbiter.timeoutMs,
          agentPreset: 'dsh-ego-arbiter',
          agentOptions: routeOptions(cfg.arbiter),
        },
      ),
    }),
  } : null;

  return { judge, checkVetoFor, getVetoLedger, vetoPlanFrom, arbiter };
}
