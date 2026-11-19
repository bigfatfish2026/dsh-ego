/**
 * 提议器引擎：stage1 规则枚举 + stage2 方案。
 *
 * 从 lib/index.js 的 apply 闭包里整段搬出来（行为零改动），apply 只负责建一次
 * 实例、把依赖递进来。原闭包里用到的配置、状态、gate、ctx 全由 deps 注入；
 * 纯函数与模块级工具（grid / proposer / rewrite / arbiter / plans-log）在这里直接 import。
 */
import { randomInt, randomUUID } from 'node:crypto';
import { MAX_ACTIONS_PER_READ, PAIR_SET, buildGrid } from '../grid.js';
import { buildStage2Options, openAgentSession } from '../agent-run.js';
import {
  buildStage2Prompt,
  buildStage2RewritePrompt,
  clampMaxRewrite,
  formatStage2Stats,
  parseStage2Plan,
} from '../proposer.js';
import { runRewriteLoop } from '../rewrite.js';
import { appendPlan, buildPlanRecord } from '../plans-log.js';
import { buildAllReadHints } from '../read-hints.js';
import { judgeFieldNames, judgeVerdictLine } from '../judge.js';
import { gateHitLines, isSelfReferential } from '../gate.js';
import { isPeak } from '../window.js';
import { clipLogText, clipText } from '../text.js';
import { cellKey, comboKey, rememberComboIn } from '../combo.js';
import { buildSolutionGoal, resolveSolutionItem } from '../backlog-pool.js';

/**
 * solution 动机的开票 goal 在这里成型（设计口径：bl-id / 方案文件 / 第一步全来自本拍读到的事实）。
 * 终审写的 goal 可能把方案路径编歪，这里直接覆盖；brief 不动，仍由 route.js 按 34 列截断。
 * 找不到池项（理论上 GA18 已拦）就保留终审原 goal，并留一行日志。
 *
 * 纯函数 + 一个日志出口：单测直接喂 decision / plan / pool，不用建 agent 会话。
 *
 * @param {object|null} decision 终审裁决（改动只发生在 action='do' 且 ticket 是对象时）
 * @param {object} plan 这一版方案（proposal 也行，读 object / step1 / plan / step2）
 * @param {object|null} candidate 这一拍挑中的候选（motivation 必须是 solution）
 * @param {Array<object>} pool 本拍已定方案池
 * @param {{log?: (line: string) => void}} [options]
 * @returns {object|null} 原 decision 或只换了 ticket.goal 的新对象
 */
export function applySolutionGoal(decision, plan, candidate, pool, { log = () => {} } = {}) {
  if (!decision || decision.action !== 'do' || String(candidate?.motivation ?? '') !== 'solution') return decision;
  const item = resolveSolutionItem(plan, pool);
  if (!item) {
    log('solution_goal_skip:plan 里的 bl-id 不在本拍池里，保留终审原 goal');
    return decision;
  }
  const goal = buildSolutionGoal(item, plan);
  if (!goal || !decision.ticket || typeof decision.ticket !== 'object') return decision;
  log(`solution_goal:${item.id}｜方案文件 ${item.hasPlanFile ? '有' : '无'}｜只做第一步`);
  return { ...decision, ticket: { ...decision.ticket, goal } };
}

/**
 * @param {object} deps
 * @param {object} deps.cfg 已合并默认值、已夹过预算的配置（apply 里那一份）
 * @param {object} deps.state 插件内存 state
 * @param {Function} deps.save 落盘 state
 * @param {Function} deps.log 单行日志
 * @param {object} deps.gate 校验层实例
 * @param {object} deps.ctx 宿主 ctx（建临时 agent 用）
 * @param {Function} deps.judge 终审入口 (proposal, nowMs)
 * @param {Function} deps.checkVetoFor 否决台账查询 (proposal, nowMs)
 * @param {object|null} deps.arbiter 第三关 arbiter（enabled=false 时为 null）
 * @param {Array} deps.readRoots 读建议枚举根
 * @param {object} deps.readHintCache 读建议进程内缓存
 * @param {object} deps.readHintOverride 读建议配置覆盖（已归一）
 * @param {() => Promise<Array<string|{id?: string}>>} [deps.readSolutionPool]
 *   「已定方案」池的取池函数（lib/backlog-pool.js 的 provider，lib/index.js 按 cfg.backlogPath 建好注入）。
 *   提议器不直接碰 sqlite：取池失败由 provider 收成空数组，buildGrid 只收结果。
 *   缺省时按空池跑（单测/老调用方不必补这一项）。
 */
export function createProposer(deps) {
  const { cfg, state, save, log, gate, ctx, judge, checkVetoFor, arbiter, readRoots, readHintCache, readHintOverride } = deps;
  const readSolutionPool = typeof deps.readSolutionPool === 'function' ? deps.readSolutionPool : async () => [];

  /**
   * 取一次本拍「已定方案」池：provider 自己吞错，这里再兜一层，
   * 保证 pool 一定是数组（后面 grid / gate / 提示词 / goal 都按数组用）。
   */
  async function solutionPoolOfRound() {
    const started = Date.now();
    let pool = [];
    try {
      pool = await readSolutionPool();
    } catch (error) {
      log(`solution_pool_fail:${String(error?.message ?? error)}`);
    }
    const list = Array.isArray(pool) ? pool.filter((one) => one && String(one.id ?? '').trim()) : [];
    log(`solution_pool:${list.length}｜${Date.now() - started}ms`);
    return list;
  }


  /**
   * 这一拍用掉的记进两份账（规则第七节）：
   *   recentCombos   这一对本身，下一拍 stage1 整对剔掉，等于轮换；去重与上限在
   *                  模块级 rememberComboIn 里（测试测那一份）。
   *   lastActionCells 这一拍的动作格，最多 M_A 条，下一拍阶段一不给这几个 A（动作格不许连拍）。
   *                   单段读没有动作格，这一栏清空——它没有耗掉任何动作格。
   * 空拍也走这里：这一对提过一次就轮换，别让同一对连着反复被选中、反复留空。
   */
  function rememberCombo(candidate) {
    state.recentCombos = rememberComboIn(state.recentCombos, comboKey(candidate));
    const cell = cellKey(candidate?.action);
    const kept = Array.isArray(state.lastActionCells) ? state.lastActionCells : [];
    state.lastActionCells = cell
      ? [...kept.filter((one) => one !== cell), cell].slice(-MAX_ACTIONS_PER_READ)
      : [];
  }

  async function propose(nowMs) {
    const section = cfg.proposer;
    if (!section.enabled) return { ok: false, skipped: true, error: 'proposer.enabled = false' };

    /*
     * 读建议：一拍算一次（readHintCache 60 秒 TTL，多拍共用）；单个根扫不动就跳过。
     * 这一栏只给模型指路，不参与 gate 判定，枚举失败也不影响这一拍。
     */
    const hintStarted = Date.now();
    const hintTable = buildAllReadHints({
      roots: readRoots,
      cache: readHintCache,
      override: readHintOverride,
    });
    const hintCount = Object.values(hintTable)
      .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    log(`read_hints:${hintCount} 条｜${Date.now() - hintStarted}ms`);

    /*
     * stage1：素材冷却（self 方向 12h）、recentCombos 的对级剔除、lastActionCells 的动作格
     * 剔除全在 grid 里做，这里不再先滤一遍素材——同一件事两处判，口径迟早会岔。
     */
    /*
     * 这一拍的格抽取 seed：真随机取 31 位整数，记日志 + state + plans.jsonl。
     * 为什么要落三个地方：日志给 grep，state 给「上一拍抽了什么」，
     * plans.jsonl 给事后重放——拿这个数当 seed 重跑 buildGrid，抽到的格必须一模一样。
     */
    // 「已定方案」池：一拍取一次；池空时 grid 会把 solution 素材整条剔掉（不叫 stage2）。
    const solutionPool = await solutionPoolOfRound();
    const gridSeed = randomInt(0, 2 ** 31 - 1);
    const candidates = buildGrid({
      materials: section.materials,
      // solution 素材要池里真有方案才进候选；buildGrid 仍是纯函数，不碰 sqlite
      solutionPool,
      primitives: section.primitives,
      objects: section.objects,
      maxCandidates: section.maxCandidates,
      lastSelfIdeaAt: state.lastSelfIdeaAt,
      recentCombos: state.recentCombos,
      // 上一拍用过的素材排到队尾：pick 只取第一格，不排后就会连着两拍同一素材，
      // 过 gate 时被 GA13 降级成 ask
      lastMaterial: state.lastMaterial,
      // 上一拍用掉的动作格：同一格不许连着两拍，最多 M_A 条
      lastActionCells: state.lastActionCells,
      // 读建议按读格的对象类挂到候选上（真实路径；渲染时进提示词末尾的「可读位置」区块）
      readHints: hintTable,
      now: nowMs,
      // 传了 seed 就走加权随机（B 版）；不传是确定性排序，只给单测/回放
      seed: gridSeed,
    });
    state.lastGridSeed = gridSeed;
    const recentCount = Array.isArray(state.recentCombos) ? state.recentCombos.length : 0;
    const singleCount = candidates.filter((one) => !one.action).length;
    log(
      `stage1_combos:${candidates.length}｜recentCombos ${recentCount} 条｜素材 ${section.materials.length} 条`
        + `｜单段读 ${singleCount} 格｜seed:${gridSeed}`,
    );
    if (candidates.length === 0) {
      return {
        ok: true,
        stage1Empty: true,
        idea: '',
        why: `stage1 没枚举出候选格（素材池空 / 原语对象开关全关 / 全被 recentCombos（${recentCount} 条）或冷却剪掉`
          + ` / solution 池 ${solutionPool.length} 条）`,
      };
    }

    /*
     * pick 规则（确定，不看模型）：取排序后的第一格。
     * grid 已按「动机权重 × 对象新鲜度」降序排好、并剔掉 recentCombos 里的格子；
     * 用掉的那格下一拍就进 recentCombos，于是自然轮到下一格——轮换靠 recentCombos，
     * 不另加计数器（多一个计数器就多一处要同步的状态）。
     */
    const candidate = candidates[0];
    // 这一拍的调用 id：落盘那行带着它，重放时能按拍对齐（comboKey 会重复，callId 不会）
    const callId = randomUUID();
    const pickedRead = cellKey(candidate.read);
    const pickedAction = cellKey(candidate.action);
    log(
      `stage2_pick:${candidate.id}｜读 ${pickedRead} → 动 ${pickedAction || '（单段读，只读不动）'}`
        + `｜格号 ${candidate.readCellId}${candidate.actionCellId ? `→${candidate.actionCellId}` : ''}`
        + `｜seed:${gridSeed}｜动机 ${candidate.motivation}｜种子：${clipLogText(candidate.material)}`,
    );
    // 单段读是规则第四节的逃生口：全拍最多一格，日志里单列一行，回头数得出来跑了几次
    if (!candidate.action) log(`stage2_single_read:1｜读格 ${pickedRead}｜动机 ${candidate.motivation}`);

    /*
     * 记账提到 gate 之前：pick 非空 = stage2 真出了方案，这一格这一拍就算用掉了。
     * 放在 gate 之后的话，gate 拒、后面裁决失败、开票失败都直接 return，recentCombos
     * 停在原地，下一拍 grid 照旧把同一格排最前（曾经有一拍就是 GA10 拒了
     * ticket 格却只字未记）。重写不重复记：同一格同一拍只记一次。
     */
    const rememberPick = (plan) => {
      if (plan.pick) {
        rememberCombo(candidate);
        // 拒掉的拍也要落盘：进程中途重启，这一笔不能只在内存里
        save();
      }
    };

    /*
     * ②.5 stage2 方案校验（GA1~GA20）：纯规则在 gate.checkStage2Plan，
     * GA3/GA4/GA5 的读盘那半走 apply 时注入的 deps（lib/exists.js），gate 自己不碰 fs。
     * 拒 = 这一拍不动作（不重试，GA4/GA5/GA9/GA14）；降级 = 可重写的（带 code 的十四关，
     * 含 GA12 的 files/steps/estLines 三个幅度分支）由 rewrite 循环直接打回重写，
     * 判不了的（GA11/GA13）照旧进终审、不许直接开票。
     */
    const checkPlan = async (plan) => {
      const verdict = await gate.checkPlan(plan, {
        candidates,
        // 单段读全拍只许一格：gate 的 GA15 要数这个数，别让它自己猜
        singleReadCount: candidates.filter((one) => !one.action).length,
        pairs: PAIR_SET,
        enabled: { primitives: section.primitives, objects: section.objects },
        peak: isPeak(new Date(nowMs), cfg.holidays ?? []),
        previousMaterial: state.lastMaterial,
        // GA18 只在本拍池里查 bl-id：池是这一拍的开票事实，不接受模型自己报的编号
        solutionPool,
      });
      // 汇总行保留原格式（现有 grep 兼容），明细紧跟在后面：每条判定一行，带一句话原因
      log(
        `ga_hits:${verdict.hits.join(',') || '无'}｜拒 ${verdict.reject.length} 条｜降级 ${verdict.downgrade.length} 条` +
          `｜未核 ${verdict.unsupported.length} 条`,
      );
      for (const line of gateHitLines(verdict)) log(line);
      if (!verdict.ok) {
        const why = verdict.reject.map((one) => `[${one.ga}] ${one.why}`).join('；');
        return { ...verdict, gateRejected: true, why: `方案没过 gate：${why}` };
      }
      return verdict;
    };

    /*
     * 空拍：pick 空 = 「这一格判过了、这一拍不用」，等 gate 放行后才记（1916bf3 的行为）。
     * 空拍不记的话，下一拍 grid 排序照旧把同一格排最前，同一格会被连着反复选中、
     * 反复留空（曾经连续两拍都是 C01｜inspect×external-repo）。
     */
    const rememberEmpty = (plan) => {
      if (!plan.pick) {
        rememberCombo(candidate);
        log(
          `stage2_empty_combo:${comboKey(candidate)}｜recentCombos ${state.recentCombos.length} 条` +
            `｜why=${clipLogText(plan.why) || '空'}`,
        );
        save();
      }
    };

    // 点子先落日志再叫终审：终审挂掉（超时/预算截断）时也能在日志里看到点子原文，
    // 否则日志里只剩「终审失败」，点子丢了。
    const judgeProposal = async (proposal) => {
      // 字段名列表照旧记，不记全文：idea/why 本来就在同一行，plan 那几栏只记名字
      log(`点子：${proposal.idea}｜理由：${proposal.why}｜judge_in:${judgeFieldNames(proposal).join(',') || '无'}`);
      const judged = await judge(proposal, nowMs);
      // 每次裁决都留一行原因（含 rewrite 那一版），事后才知道每版为什么这么判
      if (judged.ok) log(judgeVerdictLine(judged.decision));
      return judged;
    };

    /*
     * stage2 会话只建一次：打回重写时对同一个 agent 做 followup，上一版读过的文件、
     * 写下的思路都还在它自己的上下文里，不用从头再读一遍。所以这里不用 runAgent
     * （它每跑一次就 dispose），改用 openAgentSession 拿一个可续接的 ask。
     */
    const opened = await openAgentSession(
      { create: (options) => ctx.agents.create(options), log },
      {
        kind: 'stage2',
        allow: section.allow,
        timeoutMs: section.timeoutMs,
        agentPreset: 'dsh-ego-proposer',
        // 预算走 stage2MaxTokens 独立一项（apply 里已夹到 2000–16000，默认 8000）
        agentOptions: buildStage2Options(section),
      },
    );
    if (!opened.ok) {
      log(`stage2_fail:call｜建会话失败：${opened.error}`);
      return { ok: false, stage2Fail: true, error: `stage2 建会话失败：${opened.error}` };
    }

    try {
      const outcome = await runRewriteLoop({
        maxRewrite: clampMaxRewrite(section.maxRewrite),
        firstPrompt: buildStage2Prompt([candidate], section.materials, { now: new Date(nowMs), state, solutionPool }),
        /*
         * 重写消息追加在同一个会话里：原因原文 + 上一版 idea/why/files
         * + 这一版被 gate 拦住的 GA 明细与逐条修法（按当轮 verdict，不沿用上一轮）+ 硬上限 3 条。
         * candidates 一起带上：GA7 的撤回模板要按候选那格的动作类型取（plan.steps 空时也能认）。
         */
        rewritePrompt: (feedback) => buildStage2RewritePrompt({ ...feedback, candidates, solutionPool }),
        stage2: async (prompt) => {
          const started = Date.now();
          const result = await opened.ask(prompt);
          const elapsed = result.ok && Number.isFinite(result.elapsedMs)
            ? result.elapsedMs
            : Math.max(0, Date.now() - started);
          // turns = 这一跑模型往返了几轮：耗时长而 turns 少 = 单轮推理慢，turns 多 = 工具往返多
          const turns = Number.isFinite(result.turns) ? result.turns : 0;
          const tools = result.toolStats ?? {};
          /**
           * 每版 stage2 结束一行结构化统计（成功、解析失败、调用失败都打）：
           * 工具往返、空 glob、输出长度都从这一跑的事件里数。verdict 用方案自己的
           * step1.verdict，失败路写 fail，空拍写 empty。
           */
          const logStats = ({ plan = null, verdict = '', outChars = 0 } = {}) => {
            const steps = Array.isArray(plan?.plan?.steps) ? plan.plan.steps.length : 0;
            log(formatStage2Stats({
              ms: elapsed,
              turns,
              tools: tools.total,
              read: tools.read,
              glob: tools.glob,
              grep: tools.grep,
              bash: tools.bash,
              filesRead: tools.filesRead,
              emptyGlobs: tools.emptyGlobs,
              outChars,
              verdict: verdict || plan?.step1?.verdict || (plan ? 'unknown' : 'empty'),
              planSteps: steps,
              estLines: Number(plan?.plan?.estLines) || 0,
            }));
          };

          // 失败路一：调用错 / 超时 / 空正文。耗时单列，便于分清是推理慢还是工具往返多
          if (!result.ok) {
            log(`stage2_fail:call｜stage2_ms:${elapsed}｜${result.error}`);
            logStats({ verdict: 'fail' });
            return { ok: false, error: `stage2 调用失败（${elapsed}ms）：${result.error}` };
          }
          // 失败路二/三：JSON 破、字段缺、pick 造格子（reason 由 parseStage2Plan 给）
          // 候选表整张传给 parse：pick 校验按整表算（gate 那边也要数单段格）
          const parsed = parseStage2Plan(result.text, { candidates });
          if (!parsed.ok) {
            log(`stage2_fail:${parsed.reason}｜stage2_ms:${elapsed}｜${parsed.detail}｜原文：${clipText(result.text)}`);
            logStats({ verdict: 'fail', outChars: [...String(result.text ?? '')].length });
            return { ok: false, error: `stage2 拿不出合法方案（${parsed.reason}，${elapsed}ms）：${parsed.detail}` };
          }
          log(
            `stage2_ok:${candidate.id}｜stage2_ms:${elapsed}｜turns:${turns}｜pick=${parsed.plan.pick || '空'}` +
              `｜${parsed.plan.plan.steps.length} 步｜intent ${parsed.plan.intent?.reversibility || '未写'}`,
          );
          logStats({ plan: parsed.plan, outChars: [...String(result.text ?? '')].length });
          return { ok: true, plan: parsed.plan };
        },
        checkPlan,
        // 第二道关：gate 之后、judge 之前查否决台账，命中直接 silent 收工
        checkVeto: (proposal) => checkVetoFor(proposal, nowMs),
        /*
         * 第三道关：arbiter。裁决器四步顺序钉死 gate → veto → arbiter → judge：
         * gate 判死的直接收工、veto 命中直接收工，只有这两关都过了才让模型判灰色条目。
         * enabled=false 时给 null，rewrite 循环把 unsure 按 unsupported 放行（老行为）。
         */
        arbiter,
        judge: judgeProposal,
        buildProposal: (plan, verdict) => ({
          ...plan,
          candidate,
          gateDowngrade: verdict.downgrade.map((one) => `[${one.ga}] ${one.why}`),
          gateNotes: verdict.notes,
          gateUnsupported: verdict.unsupported.map((one) => `[${one.ga}] ${one.why}`),
        }),
        onPick: rememberPick,
        onEmpty: rememberEmpty,
        /*
         * 方案落盘：每一版 stage2 plan 收口时写一行，
         * 不管 gate 过没过、abort 还是 continue、重写到第几轮。
         * appendPlan 自己吞掉所有写盘错误（只记一行 plans_log_fail），
         * rewrite 循环那边再兜一层 try/catch，绝不影响这一拍的裁决。
         */
        onPlanRecord: (entry) => {
          appendPlan(buildPlanRecord({
            ts: Date.now(),
            callId,
            comboKey: comboKey(candidate),
            candidate,
            plan: entry.plan,
            verdict: entry.verdict,
            veto: entry.veto,
            judge: entry.judge,
            outcome: entry.outcome,
            round: entry.round,
            // 这一拍 stage1 的抽取 seed：事后按它重跑就能复现抽到哪一格
            gridSeed,
          }), { file: cfg.plansPath, log });
        },
        log,
      });

      if (outcome.kind === 'stage2Fail') {
        return { ok: false, stage2Fail: true, error: outcome.error };
      }
      if (outcome.kind === 'gateRejected') {
        return { ok: true, gateRejected: true, idea: '', why: outcome.why, hits: outcome.hits, rewrites: 0 };
      }
      if (outcome.kind === 'vetoRejected') {
        // 否决台账命中：这一拍不进 judge、不 rewrite，跟 gate 拒一个待遇（规则第七、十节）
        return { ok: true, vetoRejected: true, idea: '', why: outcome.reason, hit: outcome.hit, rewrites: Number(outcome.rewrites) || 0 };
      }
      if (outcome.kind === 'judgeFail') {
        return { ok: false, error: outcome.error };
      }
      /*
       * 读了判断不动（step1.verdict=abort）：这是两段式的正常收工，不是失败。
       * 这一拍没有动作，所以 idea 置空、不进终审；recentCombos / lastActionCells 已经记过账。
       */
      if (outcome.kind === 'abort') {
        const plan = outcome.plan;
        const readWhat = String(plan.step1?.read ?? '').trim();
        log(`stage2_abort:${comboKey(candidate)}｜读了 ${clipLogText(readWhat)}｜why=${clipLogText(plan.why) || '空'}`);
        save();
        return {
          ok: true,
          aborted: true,
          idea: '',
          why: `读下来不值得动（读了 ${readWhat || '（没写读了哪儿）'}）：${plan.why || ''}`,
          candidate,
          step1: plan.step1,
        };
      }

      const finalPlan = outcome.proposal ?? outcome.plan;
      // GA13 的轻校验读它：同一素材不许连续两拍。只跟着「真做了」走，空拍不消耗素材
      if (finalPlan?.pick) {
        state.lastMaterial = String(candidate.material ?? '').trim();
        // 自我优化方向命中就记时间：12 小时内不再往这个方向提（grid 的冷却读它）
        if (isSelfReferential(finalPlan.idea)) {
          state.lastSelfIdeaAt = nowMs;
          log('这一拍是自我优化方向，记下时间（12 小时内不再提同一方向）');
        }
      }
      save();
      return {
        ok: true,
        ...finalPlan,
        candidate,
        // solution 的开票 goal 按本拍池项重拼；别的动机原样返回终审裁决。
        // 这里用 finalPlan（= proposal，含 object / step1 / plan）而不是 outcome.plan：
        // rewrite 循环在 decided 分支只回 decision + proposal，没有 plan 字段。
        decision: applySolutionGoal(outcome.decision, finalPlan, candidate, solutionPool, { log }),
        rewrites: outcome.rewrites,
        gateDowngrade: finalPlan.gateDowngrade ?? [],
        gateNotes: finalPlan.gateNotes ?? [],
        gateUnsupported: finalPlan.gateUnsupported ?? [],
      };
    } finally {
      await opened.dispose();
    }
  }
  return { propose };
}
