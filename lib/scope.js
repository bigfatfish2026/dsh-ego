/**
 * 会话场景判定。
 *
 * 聊天前端在 session key 里给会话打的「场景」标记各家叫法不同：常见的是 c2c / group，
 * 也有叫 direct / private / p2p 的。插件只关心一件事——这是不是私聊。
 * 认不出就当不知道（宁可不学目标会话，也不把群聊当成私聊去说话）。
 */

/** 认作「私聊」的场景标记（小写比较）。 */
export const DIRECT_SCOPES = Object.freeze(['c2c', 'direct', 'private', 'p2p']);

/** 认作「群聊」的场景标记。 */
export const GROUP_SCOPES = Object.freeze(['group', 'channel', 'room']);

function normalize(scope) {
  return String(scope ?? '').trim().toLowerCase();
}

/** @param {unknown} scope @returns {boolean} */
export function isDirectScope(scope) {
  return DIRECT_SCOPES.includes(normalize(scope));
}

/** @param {unknown} scope @returns {boolean} */
export function isGroupScope(scope) {
  return GROUP_SCOPES.includes(normalize(scope));
}

/** 认得的场景标记（私聊 + 群聊）；其它一律当「认不出」。 */
export function isKnownScope(scope) {
  return isDirectScope(scope) || isGroupScope(scope);
}
