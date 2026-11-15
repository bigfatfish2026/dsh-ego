/**
 * 日志 / 诊断用的文本裁剪。
 *
 * 只在「给人看的那一行」上动手，校验永远吃完整文本。
 * 踩过的坑：报错时写 `result.text.slice(0, 160)`，日志里那段 JSON 正好断在 160 个字符，
 * 看上去像模型输出被截断；实际 session 里存的是完整闭合的回复。
 * 所以现在的规矩是：
 *   · 日志单行可以长，超过上限才截，且末尾必须写明「日志截断，原文 N 字符」；
 *   · 校验失败的诊断贴「前 200 + 后 100」，中间省略多少字写清楚，一眼能看出断在哪。
 */

/** 日志单行上限（字符数）。正常日志远到不了，只有贴模型回复时才可能超 */
export const LOG_TEXT_MAX = 4000;

/** 按字符（码点）数长度，和 judge.charLength 同一口径 */
function chars(text) {
  return [...String(text ?? '')];
}

/**
 * 写日志用：不截断（单行可以长），超过上限才截断并在末尾明确标记原文长度。
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function clipLogText(text, max = LOG_TEXT_MAX) {
  // 日志一行一条：换行折成空格（不算截断，内容一个不少）
  const s = String(text ?? '').replace(/\s*\r?\n\s*/g, ' ');
  const all = chars(s);
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : LOG_TEXT_MAX;
  if (all.length <= limit) return s;
  return `${all.slice(0, limit).join('')}…[日志截断，原文 ${all.length} 字符]`;
}

/**
 * 校验失败时贴原文：头 head + 尾 tail，中间省略多少字写清楚。
 * 短文本原样带上长度，不额外加工。
 * @param {string} text
 * @param {{head?: number, tail?: number}} [options]
 * @returns {string}
 */
export function clipText(text, { head = 200, tail = 100 } = {}) {
  const all = chars(text);
  const n = all.length;
  const h = Number.isFinite(Number(head)) && Number(head) >= 0 ? Number(head) : 200;
  const t = Number.isFinite(Number(tail)) && Number(tail) >= 0 ? Number(tail) : 100;
  if (n <= h + t) return `原文 ${n} 字符：${all.join('')}`;
  return `原文 ${n} 字符：${all.slice(0, h).join('')}…[省略 ${n - h - t} 字符]…${all.slice(n - t).join('')}`;
}
