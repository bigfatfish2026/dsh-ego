/**
 * 三段模型的输出预算（maxTokens）与夹取区间。
 *
 * 早期版本三段都写 0 = 不设上限，请求里干脆不带 max_tokens，交给服务端默认；
 * 结果终审被服务端默认预算截在 870 字符，JSON 没闭合，整拍判 judgeFail。
 * 从这一版起三段都显式给上限，代码里有默认值，配置里也能改：
 *   · judge.maxTokens            默认 4000，区间 1000–8000
 *   · arbiter.maxTokens          默认 1500，区间 500–4000（只回一段小 JSON，最省）
 *   · proposer.maxTokens         默认 2000，区间 2000–16000（stage1 那一档，留好接口）
 *   · proposer.stage2MaxTokens   默认 8000，区间 2000–16000（stage2 输出结构化字段，最费）
 *
 * 0 不再当「不限」：老配置里写着 0 的按默认值跑并打一行日志。
 * 越界只夹边界 + warn，不拒加载（跟 maxRewrite 一个口径）。
 */

/** 每一档的默认值与夹取区间（name 只用于日志） */
export const MAX_TOKENS_RANGES = Object.freeze({
  judge: Object.freeze({ name: 'judge.maxTokens', def: 4000, min: 1000, max: 8000 }),
  stage1: Object.freeze({ name: 'proposer.maxTokens', def: 2000, min: 2000, max: 16000 }),
  stage2: Object.freeze({ name: 'proposer.stage2MaxTokens', def: 8000, min: 2000, max: 16000 }),
  arbiter: Object.freeze({ name: 'arbiter.maxTokens', def: 1500, min: 500, max: 4000 }),
});

export const JUDGE_MAX_TOKENS_DEFAULT = MAX_TOKENS_RANGES.judge.def;
export const STAGE1_MAX_TOKENS_DEFAULT = MAX_TOKENS_RANGES.stage1.def;
export const STAGE2_MAX_TOKENS_DEFAULT = MAX_TOKENS_RANGES.stage2.def;
export const ARBITER_MAX_TOKENS_DEFAULT = MAX_TOKENS_RANGES.arbiter.def;

/**
 * 把配置里的一个 maxTokens 归一到区间内。
 *
 * 口径：缺省 / 非数字 / <= 0 → 默认值（0 是上一版「不限」的老写法，不再认）；
 * 小数截整；小于下界夹下界、大于上界夹上界。每一步都走 warn，配置写错看得见。
 *
 * @param {unknown} value 配置里读到的值
 * @param {{name?: string, def: number, min: number, max: number}} range
 * @param {{warn?: (line: string) => void}} [options]
 * @returns {number}
 */
export function clampMaxTokens(value, range, { warn } = {}) {
  const say = (line) => {
    if (typeof warn === 'function') warn(line);
  };
  const { name = 'maxTokens', def, min, max } = range ?? MAX_TOKENS_RANGES.judge;
  if (value === undefined || value === null || value === '') {
    return def;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    say(`${name}=${JSON.stringify(value)} 不是数字，按默认 ${def} 跑`);
    return def;
  }
  if (raw === 0) {
    // 老配置：0 = 不设上限。现在必须有上限，按默认跑，别让截断再来一次
    say(`${name}=0 是旧的「不限」写法，现在按默认 ${def} 跑（要改就写正数）`);
    return def;
  }
  const whole = Math.trunc(raw);
  if (whole !== raw) say(`${name}=${raw} 不是整数，截成 ${whole}`);
  if (whole < 0) {
    say(`${name}=${raw} 是负数，按默认 ${def} 跑`);
    return def;
  }
  if (whole < min) {
    say(`${name}=${raw} 小于 ${min}，夹到 ${min}`);
    return min;
  }
  if (whole > max) {
    say(`${name}=${raw} 超过 ${max}，夹到 ${max}`);
    return max;
  }
  return whole;
}

/** judge.maxTokens：默认 4000，区间 1000–8000 */
export const clampJudgeMaxTokens = (value, options) => clampMaxTokens(value, MAX_TOKENS_RANGES.judge, options);
/** proposer.maxTokens（stage1 档）：默认 2000，区间 2000–16000 */
export const clampStage1MaxTokens = (value, options) => clampMaxTokens(value, MAX_TOKENS_RANGES.stage1, options);
/** proposer.stage2MaxTokens：默认 8000，区间 2000–16000 */
export const clampStage2MaxTokens = (value, options) => clampMaxTokens(value, MAX_TOKENS_RANGES.stage2, options);
/** arbiter.maxTokens：默认 1500，区间 500–4000 */
export const clampArbiterMaxTokens = (value, options) => clampMaxTokens(value, MAX_TOKENS_RANGES.arbiter, options);
