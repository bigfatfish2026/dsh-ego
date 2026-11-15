/**
 * stage2 的「打回重写」循环：判 rewrite → 同一个 propose 会话里续一版 → 重新 gate → 再裁决。
 *
 * 两个触发源：
 *   · gate 的可重写降级（downgrade 项带 code，见 gate.js 的 REWRITE_CODES）：
 *     GA12 的 files / steps / estLines 三个幅度分支，加上 GA1/GA2/GA3/GA6/GA7/GA8/GA10/
 *     GA15/GA16/GA17 这十关。不进终审，直接打回；
 *   · 终审 action=rewrite：打回，reason 原样喂回 stage2。
 *
 * 次数上限 maxRewrite（1–5，默认 3）用满后按「最后一次被打回的原因」落回原处置：
 *   · 终审判 rewrite → ask（judge 说能改好，没改好得问人）；
 *   · gate 降级项自带 originalAction：原本判拒的关落 silent，原本判降级的关落 ask。
 * 每个降级项都带「来源关卡 ga + 该关原本的处置」，收尾按这张表决定，不在循环里硬编码各关。
 *
 * 纯编排：stage2 / checkPlan / judge 全由 index 注入，单测给假函数就能跑完整条路。
 */
import { REWRITE_CODES } from './gate.js';
import { arbiterCaseLine, arbiterFailLine, arbiterJudgeLine, arbiterRetryLine, arbiterSkipLine, mergeArbiterVerdicts } from './arbiter.js';
import { clipLogText } from './text.js';

/**
 * 这一版方案是不是被 gate 的可重写降级打回的。
 * 只认带 code 且在 REWRITE_CODES 里的降级项（GA11/GA13 判不了，没有 code，照旧进终审）。
 * @param {{downgrade?: Array<{ga?: string, code?: string, originalAction?: string, why?: string}>}} verdict
 * @returns {{source: string, ga: string, code: string, originalAction: string, reason: string}|null}
 */
export function rewriteSource(verdict) {
  const list = Array.isArray(verdict?.downgrade) ? verdict.downgrade : [];
  const hit = list.find((one) => {
    const code = String(one?.code ?? '');
    return code !== '' && REWRITE_CODES.has(code);
  });
  if (!hit) return null;
  const ga = String(hit.ga ?? '').trim() || String(hit.code);
  return {
    // source 沿用 ga 名：日志与重写提示词都按「GA12 / GA1 / …」认
    source: ga,
    ga,
    code: String(hit.code),
    // 原本判拒 = silent；原本判降级 = ask。缺省按 ask，别让没标的一律静默
    originalAction: String(hit.originalAction ?? '') === 'silent' ? 'silent' : 'ask',
    reason: String(hit.why ?? '').trim(),
  };
}

/**
 * arbiter 要看的那一小段方案：点子 / why / object / anchor / 第一步读什么 / 要改什么 / 文件 / 素材。
 * 只给方案片段，不给提议器的过程——arbiter 判的是「这条灰色条目该不该拦」，不是重判整份方案。
 * @param {object} plan
 * @param {object} proposal buildProposal 拼出来的那份（带 candidate）
 * @returns {object}
 */
function arbiterCtxOf(plan, proposal) {
  const candidate = proposal?.candidate ?? null;
  return {
    candidateId: String(candidate?.id ?? '').trim(),
    idea: plan?.idea,
    why: plan?.why,
    object: plan?.object,
    anchor: plan?.object?.anchor,
    step1: plan?.step1,
    step2: plan?.step2,
    files: plan?.plan?.files,
    material: candidate?.material,
  };
}

/**
 * 次数用满时的落点：judge 或原本降级的关 → ask（问一句要不要开票，不自己开）；
 * 原本判拒的关 → silent（这一拍不动作、不打扰用户），绝不无限循环。
 * @param {number} rewrites 已经重写了几次
 * @param {string} reason 最后一次被打回的原因原文
 * @param {'silent'|'ask'} [originalAction] 最后一次来源关卡原本的处置
 */
export function exhaustedDecision(rewrites, reason, originalAction = 'ask') {
  const why = String(reason ?? '').trim() || '最后一次仍是 rewrite';
  if (originalAction === 'silent') {
    return {
      action: 'silent',
      text: '',
      ticket: null,
      reason: `rewrite_exhausted：${why}`,
      rewritten: rewrites,
      originalAction: 'silent',
    };
  }
  return {
    action: 'ask',
    text: `改了 ${rewrites} 次还是没改好，要不要开票？`,
    ticket: null,
    reason: `rewrite_exhausted：${why}`,
    rewritten: rewrites,
    originalAction: 'ask',
  };
}

/**
 * 跑完一整条 stage2 → gate → judge（必要时重写）的路。
 *
 * @param {object} options
 * @param {number} options.maxRewrite 已归一的次数上限
 * @param {string} options.firstPrompt 第一版提示词
 * @param {(feedback: object) => string} options.rewritePrompt 重写提示词
 * @param {(prompt: string) => Promise<{ok: true, plan: object}|{ok: false, error: string}>} options.stage2
 * @param {(plan: object) => Promise<object>} options.checkPlan 返回 gate 的 verdict
 * @param {((proposal: object) => Promise<{ok: boolean, reason?: string, hit?: object}>)|null} [options.checkVeto]
 *   否决台账（第二道关）：gate 通过后、judge 之前查；命中直接 silent 收工，不 rewrite
 * @param {({enabled?: boolean, run: (cases: Array<object>, ctx: object) => Promise<{
 *   verdicts: Array<object>, failed?: string|null, total?: number, sent?: number, skipped?: number, ms?: number,
 * }>})|null} [options.arbiter]
 *   第三道关（arbiter）：gate 的 unsure 非空时调；失败一律降级成 unsupported，不拒整拍
 * @param {(proposal: object) => Promise<{ok: true, decision: object}|{ok: false, error: string}>} options.judge
 * @param {(plan: object, verdict: object) => object} options.buildProposal
 * @param {(plan: object) => void} [options.onPick] pick 非空、gate 之前记账
 * @param {(plan: object) => void} [options.onEmpty] 空拍、gate 放行之后记账
 * @param {(entry: {plan: object, verdict: object, veto: object|null, judge: object|null, round: number, outcome: string}) => void}
 *   [options.onPlanRecord] 每一版 plan 收口时回调一次（落盘用，见 lib/plans-log.js）；
 *   抛错不外溢，只记一行日志，绝不影响裁决
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<object>} kind = stage2Fail | gateRejected | abort | empty | judgeFail | decided | exhausted
 */
export async function runRewriteLoop(options) {
  const {
    maxRewrite = 3,
    firstPrompt,
    rewritePrompt,
    stage2,
    checkPlan,
    checkVeto = null,
    arbiter = null,
    judge,
    buildProposal,
    onPick = () => {},
    onEmpty = () => {},
    onPlanRecord = null,
    log = () => {},
  } = options ?? {};

  /** 每一版 plan 只回调一次：落盘失败不许影响这一拍的裁决 */
  const emit = (entry) => {
    if (typeof onPlanRecord !== 'function') return;
    try {
      onPlanRecord(entry);
    } catch (error) {
      log(`plans_log_fail:${String(error?.message ?? error)}`);
    }
  };

  let rewrites = 0;
  let feedback = null;
  let lastReason = '';

  while (true) {
    const prompt = feedback ? rewritePrompt(feedback) : firstPrompt;
    const ran = await stage2(prompt);
    if (!ran.ok) return { kind: 'stage2Fail', error: ran.error };
    const plan = ran.plan;
    /*
     * 这一版 plan 的落盘草稿：gate / veto / judge 谁先跑出来就填谁，
     * 收口（拒、abort、空拍、重写、拍板）时一次性 emit 出去。round 记的是这一版是第几轮重写。
     */
    const draft = { plan, verdict: null, veto: null, judge: null, round: rewrites };

    // pick 非空 = 真出了方案：gate 之前记账，gate 拒也留痕（沿用 1916bf3 之后的行为）
    if (plan.pick) onPick(plan);

    const verdict = await checkPlan(plan);
    draft.verdict = verdict;
    if (!verdict.ok) {
      const why = verdict.reject.map((one) => `[${one.ga}] ${one.why}`).join('；');
      emit({ ...draft, outcome: 'gate_rejected' });
      return { kind: 'gateRejected', why: `方案没过 gate：${why}`, hits: verdict.hits };
    }

    /*
     * 先把「可重写降级来源」算出来，再看 abort。
     * 曾经有一拍：gate 降级了 GA6/GA7/GA10（都在 REWRITE_GATE_ACTIONS 里），
     * stage2 自己却写了 step1.verdict=abort，旧顺序里 abort 短路排在 rewriteSource 前面，
     * 于是这一拍直接 silent 收工，一次 rewrite 都没跑。现在改成：
     * 有可重写降级项 → 先重写，abort 留到重写完（或用满次数落回）之后再判。
     */
    const fromGateBefore = rewriteSource(verdict);
    const aborting = Boolean(plan.pick) && String(plan.step1?.verdict ?? '').trim().toLowerCase() === 'abort';

    // 纯 abort：gate 没有可重写降级项，照旧直接 silent 收工，不叫终审、不多跑一次 stage2
    if (aborting && !fromGateBefore) {
      emit({ ...draft, outcome: 'abort' });
      return { kind: 'abort', plan, rewrites };
    }

    // 空拍：等 gate 放行后再记账
    if (!plan.pick) {
      onEmpty(plan);
      emit({ ...draft, outcome: 'empty' });
      return { kind: 'empty', plan, verdict };
    }

    const proposal = buildProposal(plan, verdict);

    /*
     * 第二道关：否决台账。位置钉在 gate 之后、abort/rewrite/judge 之前
     * （规则第七节「gate 与 abort 之后、交 judge 之前」；第十节「命中一律 silent，不 rewrite」）。
     * 命中时这一拍不进 judge，省一次模型调用，跟 gate 拒一个待遇。
     */
    if (checkVeto && plan.pick) {
      const veto = await checkVeto(proposal);
      draft.veto = {
        ok: veto?.ok !== false,
        hit: veto?.ok === false ? (veto?.hit ?? null) : null,
        ran: true,
      };
      if (veto && veto.ok === false) {
        emit({ ...draft, outcome: 'veto_rejected' });
        return {
          kind: 'vetoRejected',
          reason: String(veto.reason ?? '').trim() || '撞上被否过的方向',
          hit: veto.hit ?? null,
          proposal,
          verdict,
          rewrites,
        };
      }
    }

    /*
     * 第三道关：arbiter —— 只处置 gate 自己判不了（unsure）的灰色条目。
     * 位置钉在 veto 之后、judge 之前：gate 判死的、veto 命中的都已经收工，到这儿才值得
     * 花一次模型调用。失败一律降级——条目全按 unsupported 放行并记 arbiter_fail，
     * 绝不因此拒掉整拍（它只是补位，不是新的否决权）。
     */
    let judgedVerdict = verdict;
    const unsure = Array.isArray(verdict?.unsure) ? verdict.unsure : [];
    if (arbiter && arbiter.enabled !== false && typeof arbiter.run === 'function' && unsure.length > 0) {
      let result;
      try {
        result = await arbiter.run(unsure, arbiterCtxOf(plan, proposal));
      } catch (error) {
        // 注入的实现自己抛错也要兜住：这一关不许把整拍带塌
        result = {
          verdicts: [],
          failed: `调用失败：${String(error?.message ?? error)}`,
          ms: 0,
          total: unsure.length,
          sent: 0,
          skipped: 0,
        };
      }
      const total = Number(result?.total) || unsure.length;
      const sent = Number.isFinite(Number(result?.sent)) ? Number(result.sent) : unsure.length;
      const skipped = Math.max(0, Number(result?.skipped) || 0);
      const merged = mergeArbiterVerdicts({ verdict, verdicts: result?.verdicts ?? [] });
      const counts = merged.counts;
      if (skipped > 0) log(arbiterSkipLine(skipped));
      // 空正文重试过就单独留一行：下次查「为什么慢了一拍」能直接对上
      if (result?.retried) log(arbiterRetryLine(sent));
      log(arbiterCaseLine({
        total,
        sent,
        ms: result?.ms,
        pass: counts.pass,
        reject: counts.reject,
        downgrade: counts.downgrade,
      }));
      for (const one of Array.isArray(result?.verdicts) ? result.verdicts : []) log(arbiterJudgeLine(one));
      if (result?.failed) log(arbiterFailLine(result.failed, unsure.length));
      judgedVerdict = merged.verdict;
      // 落盘要记合并后的结果：不然重放时看不出 arbiter 判了什么
      draft.verdict = judgedVerdict;
      if (!judgedVerdict.ok) {
        const why = judgedVerdict.reject.map((one) => `[${one.ga}] ${one.why}`).join('；');
        emit({ ...draft, outcome: 'gate_rejected' });
        return { kind: 'gateRejected', why: `方案被 arbiter 拦下：${why}`, hits: judgedVerdict.hits };
      }
    }

    // 触发源 a：gate 的可重写降级（含 arbiter 判 downgrade 的），不进终审，直接打回
    const fromGate = rewriteSource(judgedVerdict);
    if (fromGate) {
      if (aborting && rewrites === 0) {
        log(`stage2_abort_override:gate ${fromGate.ga}(${fromGate.code}) 可重写，先重写不 abort`);
      }
      lastReason = fromGate.reason;
      if (rewrites >= maxRewrite) {
        log(`rewrite_exhausted:共${rewrites}次｜原因:${fromGate.ga}｜落回:${fromGate.originalAction}｜${clipLogText(lastReason)}`);
        emit({ ...draft, outcome: 'exhausted' });
        return {
          kind: 'exhausted',
          decision: exhaustedDecision(rewrites, lastReason, fromGate.originalAction),
          proposal,
          verdict: judgedVerdict,
          rewrites,
        };
      }
      emit({ ...draft, outcome: 'rewrite' });
      rewrites += 1;
      // 格式固定：第几次 / 谁触发的 / 还剩几次 / 一句话原因，日志里能直接定位是哪一版、哪一关
      log(`stage2_rewrite:${rewrites}｜by:${fromGate.ga}｜left:${Math.max(0, maxRewrite - rewrites)}｜why:${clipLogText(lastReason)}`);
      feedback = {
        source: fromGate.ga,
        ga: fromGate.ga,
        code: fromGate.code,
        reason: lastReason,
        idea: plan.idea,
        why: plan.why,
        files: plan.plan?.files ?? [],
        // 上一版整份方案带上：重写消息里除了原因，还要列出「具体哪个字段不合格」的原文
        plan,
        // 这一版的 gate 结果（合并了 arbiter 判定）：重写消息按它逐条列
        // 「被谁拦、拦在哪个字段、该怎么补」。每轮现取，别沿用到下一轮。
        verdict: judgedVerdict,
      };
      continue;
    }

    const judged = await judge(proposal);
    if (!judged.ok) return { kind: 'judgeFail', error: judged.error };
    const decision = judged.decision;
    draft.judge = { action: String(decision?.action ?? ''), reason: String(decision?.reason ?? '') };

    // 触发源 b：终审判 rewrite
    if (decision.action === 'rewrite') {
      lastReason = String(decision.reason ?? '').trim();
      if (rewrites >= maxRewrite) {
        log(`rewrite_exhausted:共${rewrites}次｜原因:judge｜落回:ask｜${clipLogText(lastReason)}`);
        emit({ ...draft, outcome: 'exhausted' });
        return {
          kind: 'exhausted',
          decision: exhaustedDecision(rewrites, lastReason, 'ask'),
          proposal,
          verdict: judgedVerdict,
          rewrites,
        };
      }
      emit({ ...draft, outcome: 'rewrite' });
      rewrites += 1;
      log(`stage2_rewrite:${rewrites}｜by:judge｜left:${Math.max(0, maxRewrite - rewrites)}｜why:${clipLogText(lastReason)}`);
      feedback = {
        source: 'judge',
        reason: lastReason,
        idea: plan.idea,
        why: plan.why,
        files: plan.plan?.files ?? [],
        plan,
        // judge 触发的这轮也带 gate 结果：没有可重写拦截项时提示词自己不出那一段
        verdict: judgedVerdict,
      };
      continue;
    }

    if (rewrites > 0) log(`stage2_rewrite_done:共${rewrites}次｜终判:${decision.action}`);
    emit({ ...draft, outcome: 'decided' });
    return { kind: 'decided', decision, proposal, verdict: judgedVerdict, rewrites };
  }
}
