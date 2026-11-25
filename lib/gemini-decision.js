/**
 * gemini-decision 薄客户端（方案 backlog-bl-mwiwuevq-176f 第 3a 节，本仓只服务 E2）。
 *
 * 干什么：把「一道 choice 题」发给本机 decision 模型（默认 http://127.0.0.1:3425/v1/systemone，
 * magpie 网关），
 * 拿回 choice + probabilities + confidence。桥不校验、不重试、只透传
 * （/home/julia/fatfish/tools/gemini-decision-bridge/index.mjs:130-152），
 * 所以六项校验必须落在这里，任何一项不过就整条请求算失败，调用方回原分支。
 *
 * 六项（顺序照方案写死，不合并、不放过）：
 *   1. HTTP 2xx——桥把上游的 400/429/5xx 原样透传，非 2xx 一律失败；
 *   2. body 是 JSON 对象，answers 是对象，answers[q1] 是对象；
 *   3. choice 是字符串且属于调用方给的 criteria 键（答案只能来自我们给的候选）；
 *   4. probabilities 是对象，键集合与 criteria 完全相等（多一个少一个都算坏）；
 *   5. 每个概率 ∈ [0,1]，且 |Σp − 1| ≤ 1e-6；
 *   6. confidence ∈ [0,1]，且 |confidence − p[choice]| ≤ 1e-6。
 *
 * 边界：
 *   - 一次调用只发一次，**不重试**；超时用 AbortSignal.timeout（不发第二遍）。
 *   - 不在这里打日志、不在这里改任何判定——调用方（lib/engines/adjudicator.js）
 *     决定「建议能不能用」，这里只回答「桥说了什么 / 为什么不算数」。
 *   - 不读 key：桥在本机 127.0.0.1，鉴权在 systemd 的 EnvironmentFile 里，插件不碰。
 */

// 2026-11-25 t-mwvek2ds：走 magpie 网关，模型只在 /v1/systemone 上认。
const DECIDE_PATH = '/v1/systemone';
/** Σp 与 confidence 的容差（实测桥回 0.99999997 / 1.0000000001 都见过） */
const SUM_TOLERANCE = 1e-6;

/** 默认值只在这里写一份，schema 在 lib/config.js 的 GeminiDecisionSection。 */
const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3425',
  model: 'gemini-decision-1',
  timeoutMs: 2500,
  minConfidence: 0.9,
};

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 配置归一化：enabled 只认严格 true（yml 里写成字符串不许误开），
 * 数值越界按硬边界夹，baseUrl 去掉尾部斜杠。
 */
export function geminiDecisionCfgOf(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const baseUrl = String(src.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(src.model ?? '').trim();
  return {
    enabled: src.enabled === true,
    baseUrl: baseUrl || DEFAULTS.baseUrl,
    model: model || DEFAULTS.model,
    timeoutMs: Math.max(200, Math.floor(finiteOr(src.timeoutMs, DEFAULTS.timeoutMs))),
    minConfidence: Math.min(1, Math.max(0, finiteOr(src.minConfidence, DEFAULTS.minConfidence))),
  };
}

function fail(reason, startedAt) {
  return { ok: false, reason, ms: Date.now() - startedAt };
}

/** 网络层的失败分类：超时与其它网络错分开记，其余一律 network。 */
function errorReason(error) {
  const name = String(error?.name ?? '');
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 六项校验（3-6 项在 body 之后）。返回失败原因或 null。
 * @returns {string|null}
 */
function checkAnswer(answer, criteriaKeys) {
  if (!isPlainObject(answer)) return 'shape';
  const choice = answer.choice;
  if (typeof choice !== 'string' || !criteriaKeys.includes(choice)) return 'choice_not_candidate';

  const probabilities = answer.probabilities;
  if (!isPlainObject(probabilities)) return 'shape';
  // criteria 的键是对象键（天然不重复），长度相等 + 每个键都在 = 两个集合完全相等
  const keys = Object.keys(probabilities);
  if (keys.length !== criteriaKeys.length) return 'prob_keys';
  if (criteriaKeys.some((key) => !keys.includes(key))) return 'prob_keys';

  let sum = 0;
  for (const key of criteriaKeys) {
    const p = probabilities[key];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return 'prob_range';
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return 'prob_sum';

  const confidence = answer.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return 'bad_confidence';
  }
  if (Math.abs(confidence - probabilities[choice]) > SUM_TOLERANCE) return 'bad_confidence';
  return null;
}

/**
 * 建一个客户端。对象无状态，一拍里建一次即可。
 *
 * @param {object} raw cfg.geminiDecision（可能缺字段 / 是字符串，归一化会兜）
 * @returns {{enabled: boolean, cfg: object, ask: (input: object) => Promise<object>}}
 */
export function createGeminiDecision(raw) {
  const cfg = geminiDecisionCfgOf(raw);

  /**
   * 问一道 choice 题。
   *
   * @param {object} input
   * @param {string} input.state 一句话事实（只进请求，不许进日志）
   * @param {string} input.instructions 题目正文
   * @param {Record<string,string>} input.criteria 候选词 → 说明（键就是 choice 的合法值）
   * @returns {Promise<{ok: true, choice: string, confidence: number, probabilities: object, ms: number}
   *   | {ok: false, reason: string, ms: number}>}
   *   reason: disabled / bad_request / timeout / network / http_<code> / bad_json /
   *   shape / choice_not_candidate / prob_keys / prob_range / prob_sum / bad_confidence
   */
  async function ask(input = {}) {
    const startedAt = Date.now();
    if (!cfg.enabled) return fail('disabled', startedAt);
    const criteria = isPlainObject(input.criteria) ? input.criteria : {};
    const criteriaKeys = Object.keys(criteria);
    const instructions = String(input.instructions ?? '').trim();
    // 至少两个候选才算「选一个」；一个候选的题桥也会判，但没有决策含义。
    if (!instructions || criteriaKeys.length < 2) return fail('bad_request', startedAt);

    const question = {
      type: 'choice',
      instructions,
      criteria: Object.fromEntries(criteriaKeys.map((key) => [key, String(criteria[key] ?? '')])),
    };

    let resp;
    try {
      resp = await fetch(`${cfg.baseUrl}${DECIDE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          state: String(input.state ?? ''),
          questions: { q1: question },
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (error) {
      return fail(errorReason(error), startedAt);
    }
    // ① HTTP 2xx：桥把上游状态码原样透传，400/429/5xx 都不是「没答案」而是「这次不算数」
    if (resp.status < 200 || resp.status >= 300) return fail(`http_${resp.status}`, startedAt);

    // ② body 形状：JSON 对象 + answers 对象 + answers.q1 对象
    let body;
    try {
      body = await resp.json();
    } catch {
      return fail('bad_json', startedAt);
    }
    if (!isPlainObject(body) || !isPlainObject(body.answers) || !isPlainObject(body.answers.q1)) {
      return fail('shape', startedAt);
    }

    // ③-⑥ 候选、键集合、概率和、置信度一致性
    const reason = checkAnswer(body.answers.q1, criteriaKeys);
    if (reason) return fail(reason, startedAt);

    const answer = body.answers.q1;
    return {
      ok: true,
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      ms: Date.now() - startedAt,
    };
  }

  return { enabled: cfg.enabled, cfg, ask };
}

export { DEFAULTS as GEMINI_DECISION_DEFAULTS };
