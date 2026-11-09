/**
 * 提议器：一段只读 agent，任务只有一个——想一个能落地的「点子」。
 *
 * 它不许说话、不许动手、不许开票；工具白名单在 cordis.patch.yml 里，
 * 这里只负责拼提示词和解析它回来的 JSON。
 */
import { extractJson } from './agent-run.js';

/**
 * 素材池兜底。开源仓库里代码不持清单：默认方向写在 cordis.patch.yml 的
 * proposer.materials，这里只留空数组，配置漏了也不会把私人工作写出进提示词。
 * 想换方向就配 `proposer.materials`，写几条就列几条。
 */
export const PROPOSER_MATERIALS = [];

/**
 * 对象名词表兜底。默认的通用名词写在 cordis.patch.yml 的 proposer.objectHints。
 * 空数组 = 不按名词表卡对象，只要求点子自带数量。
 */
export const IDEA_OBJECT_HINTS = [];

/**
 * 查 idea 够不够具体。
 * @param {string} idea
 * @param {{objectHints?: string[]}} [options] 覆盖默认对象名词表（配置项 `proposer.objectHints`）
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateIdea(idea, { objectHints = IDEA_OBJECT_HINTS } = {}) {
  const raw = String(idea ?? '').trim();
  if (!raw) return { ok: true, problems: [] }; // 空串 = 今天没话说，合法
  const hints = Array.isArray(objectHints) ? objectHints.map(String).filter((word) => word.trim()) : [];
  const problems = [];
  if (!/\d/.test(raw)) problems.push('没写数量（要动几条 / 几个 / 哪几处）');
  const hasIdentifier = /[A-Za-z][A-Za-z0-9_.\-/]{2,}/.test(raw);
  // 词表为空 = 没配清单，不拿名词卡对象；否则「hints 为空」会把所有点子都判死。
  const hasObjectNoun = hints.some((word) => raw.includes(word));
  if (hints.length > 0 && !hasIdentifier && !hasObjectNoun) {
    problems.push('没写对象（表名 / 路径 / 服务 / 文件）');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 提议器提示词。
 * @param {{now?: Date, state?: object, materials?: string[]}} input
 *   materials 覆盖默认素材池（配置项 `proposer.materials`）
 */
export function buildProposerPrompt({ now = new Date(), state = {}, materials = PROPOSER_MATERIALS } = {}) {
  // 空素材池不占位：不输出空的「可以往这些方向想」和空编号段。
  const lines = Array.isArray(materials) ? materials.map((line) => String(line).trim()).filter(Boolean) : [];
  const directionLines = lines.length > 0
    ? ['可以往这些方向想（挑一个真的值得说的，别硬凑）：', ...lines.map((line, i) => `  ${i + 1}. ${line}`), '']
    : [];
  const stamp = now.toISOString();
  const lastReport = Number(state?.lastReportAt) > 0
    ? new Date(Number(state.lastReportAt)).toISOString()
    : '（还没有记录）';
  return [
    '（这是你自己开的一轮，不是谁发来的消息，别回应它，顺着做就行。）',
    '',
    '你是运行在 agent 宿主里的助手。现在只有一件事要你干：想一个「点子」。',
    '想点子的时候你手上只有只读工具（read / glob / grep / 记忆检索 / 搜索 / 主机状态），',
    '一个字都不许写、不许改、不许跑命令、不许开票、不许联系用户——那些由别人决定。',
    '',
    ...directionLines,
    `现在是 ${stamp}。上次让用户知道点事是 ${lastReport}。`,
    '上一个点子：' + (state?.lastReason ? String(state.lastReason).slice(0, 200) : '（没有）'),
    '',
    '规矩：',
    '· 点子要具体到「一句话就能说清要干什么」，而且必须自带对象和数量：',
    '  例：「example-db 的 jobs 表里有 55 条 retry 记录」——有表名、有 55 条。',
    '  反例：「整理一下仓库」「清理一堆没用的东西」——没有对象、没有数量，等于没法判。',
    '· why 里写依据：为什么值得动，一句话带数字或事实（原文没了 / 占名额 / 过期多久 / 队列多长）。',
    '· 想不出值得说的就老实认，idea 留空串，why 写清为什么今天没什么好说的。',
    '· 只输出一个 JSON 对象，别加解释、别加围栏之外的废话：',
    '{"idea": "一句话的点子（含对象 + 数量）", "why": "为什么值得说，带依据"}',
  ].join('\n');
}

/**
 * 解析提议器的回复。
 * idea 为空串是合法结果（= 今天没话说）；字段缺失、不是 JSON、idea 没写清对象/数量一律 null（当这一拍失败）。
 * @param {string} text
 * @param {{objectHints?: string[]}} [options]
 * @returns {{idea: string, why: string}|null}
 */
export function parseProposal(text, { objectHints } = {}) {
  const value = extractJson(text);
  if (!value) return null;
  if (typeof value.idea !== 'string' || typeof value.why !== 'string') return null;
  const idea = value.idea.trim();
  const why = value.why.trim();
  if (!validateIdea(idea, { objectHints }).ok) return null;
  return { idea, why };
}
