/**
 * 组合键与 recentCombos 记账的纯函数。
 *
 * 提议器（lib/engines/proposer.js）用 cellKey / comboKey 记这一拍提了哪一对，
 * 裁决器（lib/engines/adjudicator.js）用 comboKey 把否决台账的判据对齐到同一口径。
 * 两处必须同一份实现，不然台账与 grid 的键迟早会岔。
 */

/**
 * 最近提过几拍的组合（state.recentCombos）：保留最近 10 条。
 * 规则 5.1 写的是「最近 10 拍提过的 id」；10 条也够轮换——基础格 17 格，
 * 剔 10 格还剩 7 格可选，不会把自己饿死。
 */
export const RECENT_COMBOS_LIMIT = 10;

/**
 * recentCombos 记账的纯函数版（提议器里的 rememberCombo 走同一份，测试直接测它）。
 *
 * 同一格重复记只留最新一条（挪到队尾），超出上限从头部丢。空 key 不记——
 * 认不出的组合塞进去只会让 grid 的 normalizeComboKey 白跑。
 *
 * @param {Array<unknown>} list 现有 recentCombos
 * @param {string} key `primitive|objectKind`，grid.normalizeComboKey 认的就是这一种写法
 * @param {number} [limit] 上限，默认 RECENT_COMBOS_LIMIT
 * @returns {Array<string>}
 */
export function rememberComboIn(list, key, limit = RECENT_COMBOS_LIMIT) {
  const clean = String(key ?? '');
  const next = Array.isArray(list)
    ? list.map((one) => String(one)).filter((one) => one && one !== clean)
    : [];
  if (clean) next.push(clean);
  return next.slice(-Math.max(1, Math.floor(Number(limit)) || RECENT_COMBOS_LIMIT));
}

/** 一格的键：`edit-file|files`（动作格记账用，也是 grid 认的那一种写法） */
export function cellKey(cell) {
  return cell ? `${cell.primitive}|${cell.objectKind}` : '';
}

/**
 * 一对的键：`inspect|files→edit-file|files`。
 * 单段读没有动作格，写成箭尾留空的 `inspect|session→`：
 * 不带箭头的 `inspect|session` 是上一版的单格记账，state.readState 会把那种老键丢掉，
 * 单段那一格就永远不轮换。箭尾留空能让它跟对一样进出 recentCombos。
 */
export function comboKey(candidate) {
  const read = cellKey(candidate?.read);
  const action = cellKey(candidate?.action);
  return action ? `${read}→${action}` : `${read}→`;
}
