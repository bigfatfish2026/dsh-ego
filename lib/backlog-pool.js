/**
 * 「已定方案」池：从 dsh-backlog 的 sqlite 里取 `status='已定方案'` 的条目，给 solution 动机用。
 *
 * 三条边界：
 *   1. **只读**：`DatabaseSync(file, { readOnly: true })`，不建库、不写、不 checkpoint。
 *      别加 `immutable=1`——那会把还没 checkpoint 的 `-wal` 当不存在，读出一份过期视图
 *      （dsh-ego 的票台探针踩过同一个坑，见 lib/ticket-gate.js 的注释）。
 *   2. **不抛**：库不在、表没有、node:sqlite 不可用，一律记一行日志后返回空数组。
 *      这一层是提议器的输入，不是闸；它挂掉只能让这一拍少一条素材，不许把整拍打崩。
 *   3. **不碰盘以外的事**：只 SELECT 五列，按 `updated_at` 升序（先定方案的先做）。
 *
 * 池项形状：`{ id, title, status, note, updatedAt, planFile, hasPlanFile }`。
 * `planFile` 优先给实际存在的方案文件（精确名 `plans/backlog-<id>.md`，或全号真名
 * `plans/backlog-bl-*-<短号>.md`），都没有才给约定落点；`hasPlanFile` 说这个文件在不在。
 * 提示词与开票 goal 都按它决定「写方案文件路径」还是「写 note 摘要」。
 *
 * engines/proposer.js 不直接调这里的取池函数：它拿一个 provider（本文件的
 * `createSolutionPoolProvider`），从 deps 注入，单测换假实现即可；buildGrid 只收结果数组。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOLUTION_STATUS, solutionIdInPlan } from './motivations.js';

export { solutionIdInPlan };

/** 工单库默认位置：与 dsh-backlog 的 DEFAULT_DB_PATH 同一个落点。 */
export const DEFAULT_BACKLOG_DB = path.join(os.homedir(), '.dsh', 'backlog', 'backlog.db');

/** 方案文档默认目录：`$DSH_EGO_ROOT/plans`（默认 `~/fatfish/plans`）。 */
export function defaultPlansDir({ home = os.homedir(), root = process.env.DSH_EGO_ROOT } = {}) {
  return path.join(String(root || path.join(home, 'fatfish')), 'plans');
}

/** 一条已定方案的约定方案文件：`plans/backlog-<id>.md`（绝对路径）。 */
export function solutionPlanFile(id, { plansDir = '' } = {}) {
  return path.join(plansDir || defaultPlansDir(), `backlog-${String(id ?? '').trim()}.md`);
}

/** 方案文件名里的「短号」：全号 `bl-<时间戳>-<4 位>` 的最后一段；裸短号原样回。 */
export function solutionPlanSuffix(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return '';
  const cut = raw.lastIndexOf('-');
  return cut >= 0 ? raw.slice(cut + 1) : raw;
}

/** 正则转义：短号要整段相等，不许把 `b40` 当成 `b40e` 的前缀放过去。 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 方案文档存在性：精确名 `backlog-<id>.md` 与全号真名 `backlog-bl-*-<短号>.md` 都认。
 *
 * 为什么要有前缀这一条：工单池里有时只剩 4 位短号（日志里的 `b40e`），而落盘的文件名
 * 是全号 `plans/backlog-bl-mwn2jrdm-b40e.md`。只按短号拼 `backlog-b40e.md` 会永远判
 * 「没有文档」，于是同一件事被反复提议（2026-11-22 那两条 b40e 提议就是这么来的）。
 * 短号必须整段相等：`backlog-bl-x-b40f.md` 不会命中短号 `b40e`。
 *
 * @param {string} id 工单 id（全号 `bl-…-xxxx` 或只剩短号 `xxxx`）
 * @param {{plansDir?: string, fs?: object}} [options] fs 可注入（单测用）
 * @returns {string} 命中文件的绝对路径；没有返回空串
 */
export function findSolutionPlanFile(id, { plansDir = '', fs: fsApi = fs } = {}) {
  const raw = String(id ?? '').trim();
  if (!raw) return '';
  const dir = plansDir || defaultPlansDir();
  const exact = path.join(dir, `backlog-${raw}.md`);
  try {
    if (fsApi.statSync(exact).isFile()) return exact;
  } catch {
    /* 精确名不存在，继续按短号找 */
  }
  const suffix = solutionPlanSuffix(raw);
  if (!suffix) return '';
  const pattern = new RegExp(`^backlog-bl-[a-z0-9]+-${escapeRegExp(suffix)}\\.md$`, 'i');
  let names;
  try {
    names = fsApi.readdirSync(dir);
  } catch {
    return '';
  }
  const hits = (Array.isArray(names) ? names : []).filter((name) => pattern.test(String(name)));
  if (hits.length === 0) return '';
  if (hits.length === 1) return path.join(dir, hits[0]);
  // 同短号多份（历史副本 / .bak 之外的重复）：取 mtime 最新那份，别按目录序瞎挑
  let best = '';
  let bestMs = -Infinity;
  for (const name of hits) {
    const file = path.join(dir, name);
    let ms = 0;
    try {
      ms = Number(fsApi.statSync(file).mtimeMs) || 0;
    } catch {
      ms = 0;
    }
    if (ms > bestMs) {
      bestMs = ms;
      best = file;
    }
  }
  return best;
}

function oneLine(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!(max > 0)) return text;
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** 一行日志：库/表/驱动哪一层出的错都要能一眼看出来，但不许把栈打出来。 */
function errText(error) {
  return String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim() || '没拿到原因';
}

/** 把 sqlite 一行收成池项（列名 snake_case → camelCase，并补方案文件落点）。 */
function toPoolItem(row, { plansDir } = {}) {
  const id = String(row?.id ?? '').trim();
  // 存在性按「精确名 + 全号前缀」两种口径找：短号也能认到 backlog-bl-*-<短号>.md
  const found = id ? findSolutionPlanFile(id, { plansDir }) : '';
  const planFile = found || solutionPlanFile(id, { plansDir });
  const hasPlanFile = Boolean(found);
  return {
    id,
    title: String(row?.title ?? '').trim(),
    status: String(row?.status ?? '').trim(),
    note: String(row?.note ?? '').trim(),
    updatedAt: String(row?.updated_at ?? '').trim(),
    planFile,
    hasPlanFile,
  };
}

/**
 * 取一次「已定方案」池。永远返回数组，永远不抛。
 *
 * @param {{file?: string, plansDir?: string, log?: (line: string) => void}} [options]
 * @returns {Promise<Array<{id: string, title: string, status: string, note: string,
 *   updatedAt: string, planFile: string, hasPlanFile: boolean}>>}
 */
export async function loadSolutionPool({ file = DEFAULT_BACKLOG_DB, plansDir = '', log = () => {} } = {}) {
  const say = (line) => {
    try {
      log(line);
    } catch {
      /* 日志写不了也不影响这一拍 */
    }
  };
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    say(`solution_pool_fail:node:sqlite 不可用｜${errText(error)}`);
    return [];
  }
  const DatabaseSync = sqlite?.DatabaseSync;
  if (typeof DatabaseSync !== 'function') {
    say('solution_pool_fail:node:sqlite 没有 DatabaseSync');
    return [];
  }

  let db;
  try {
    // readOnly：库不在就直接抛（不建库），由下面的 catch 收成空池；
    // 不加 immutable=1，理由见文件头。
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(`SELECT id, title, status, note, updated_at FROM backlog WHERE status = ? ORDER BY updated_at ASC, id ASC`)
      .all(SOLUTION_STATUS);
    return (Array.isArray(rows) ? rows : []).map((row) => toPoolItem(row, { plansDir }));
  } catch (error) {
    say(`solution_pool_fail:${file}｜${errText(error)}`);
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* close 失败不影响结果 */
    }
  }
}

/**
 * 取池 provider：engines/proposer.js 只认这个形状（`async () => pool`），
 * 由 lib/index.js 按 `cfg.backlogPath` 建一次、注入进去。
 * 这里再包一层 try/catch：即便 loadSolutionPool 被换成会抛的实现，也不许把整拍带塌。
 *
 * @param {{file?: string, plansDir?: string, log?: (line: string) => void}} [options]
 * @returns {() => Promise<Array<object>>}
 */
export function createSolutionPoolProvider({ file = DEFAULT_BACKLOG_DB, plansDir = '', log = () => {} } = {}) {
  return async () => {
    try {
      return await loadSolutionPool({ file, plansDir, log });
    } catch (error) {
      try {
        log(`solution_pool_fail:${errText(error)}`);
      } catch {
        /* 日志写不了也不影响这一拍 */
      }
      return [];
    }
  };
}

/** 按方案里写的 bl-id 在池里找对应条目；找不到返回 null。 */
export function resolveSolutionItem(plan, pool) {
  const found = solutionIdInPlan(plan);
  if (!found) return null;
  const list = Array.isArray(pool) ? pool : [];
  return list.find((one) => String(one?.id ?? '').trim() === found.id) ?? null;
}

/**
 * 开票 goal（设计原文）：`执行已定方案 <bl-id>：<一句话目标>。方案文件 <绝对路径>
 * （无文件则写 note 摘要）；只做第一步：<步骤>；完成后把该条目改已完成。`
 *
 * 只拼字符串，不叫模型：goal 里的 bl-id、方案路径、步骤全部来自本拍读到的事实。
 * brief 不在这里处理，仍走 route.js 的 34 列截断。
 *
 * @param {object} item 池项（loadSolutionPool 的形状，至少 id/title/note）
 * @param {object} plan parseStage2Plan 的 plan
 * @returns {string} 空串 = item 没有 id，拼不出合法 goal（调用方保留终审原 goal）
 */
export function buildSolutionGoal(item, plan) {
  const id = String(item?.id ?? '').trim();
  if (!id) return '';
  const target = oneLine(plan?.idea, 120) || oneLine(item?.title, 80) || '按已定方案落地第一步';
  const hasFile = typeof item?.hasPlanFile === 'boolean' ? item.hasPlanFile : Boolean(item?.planFile && fs.existsSync(item.planFile));
  const planFile = String(item?.planFile ?? '').trim() || solutionPlanFile(id);
  const source = hasFile
    ? `方案文件 ${planFile}`
    : `方案摘要：${oneLine(item?.note, 120) || oneLine(item?.title, 80) || '（这条方案没有正文，按标题执行）'}`;
  const step = oneLine(plan?.step2?.change, 160)
    || oneLine(Array.isArray(plan?.plan?.steps) ? plan.plan.steps[0] : '', 160)
    || '按方案第一步执行';
  return `执行已定方案 ${id}：${target}。${source}；只做第一步：${step}；完成后把该条目改已完成。`;
}
