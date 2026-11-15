/**
 * 票台闸：一拍在「生成想法」之前，先看 dispatcher 票台上有没有还没结束的票。
 *
 * 为什么要有这道闸：ego 每小时自己醒一次，可能正好撞上主会话/worker 正在干的活，
 * 这时候再冒一个念头出来只会打扰人。所以票台上一旦有 open / running / waiting /
 * blocked 任意一张，这一拍就轮空：不提议、不开票、不发消息，只记一行日志和计数。
 *
 * 查票台的方式（两个来源都探，结果取大者）：
 *   1. dispatcher 对外 provide 了 cordis 服务 `dispatcher/tickets`
 *      （dsh-dispatcher/lib/index.js 的 ctx.provide(TICKETS_SERVICE, readout)），
 *      readout.payload({ open: true }) 里的 counts.openTotal 就是四态合计；
 *   2. 只读打开 sqlite：`SELECT COUNT(*) FROM tickets WHERE state IN (...)`。
 *      投影表的列名是 `state` 不是 `status`（见 dsh-dispatcher 的 CREATE TABLE）。
 *      DatabaseSync 以 readOnly:true 打开，不开事务、不拿写锁。
 *
 * 为什么两个都探、取大者（一次实测的教训）：有一拍闸放行，事后查票库
 * 发现那一刻未结票真的是 0（三张票在前 40 秒里先后关掉），但当时没人能从日志里看出
 * 探针走的哪条路、读的什么数。只信一个源，任何一头谎报 0 都会静默放行；两头都读、
 * 取大者，一边谎报另一边还能兜住，而且每拍留一行日志，下次一眼就能对账。
 *
 * busy 的语义（别简化成「读到 N > 0」）：
 *   · service 或 sqlite **任一源**报 > 0 → busy；
 *   · service 读不到/抛错，sqlite 读到 0 → 信 sqlite，不忙；
 *   · **两个源都拿不到/都抛错 → busy**（宁可白等一拍，也不在票台状态不明时插话）；
 *   · 只有两源都确实读到 0，才算空、才往下掷骰。
 *
 * 纯查询/文案函数放这里，tick 那边只调用注入的 probeTickets，好让单测不碰宿主 ctx。
 */
import os from 'node:os';
import path from 'node:path';
import { probed } from './helpers.js';

/** dispatcher 提供的只读票台服务名（dsh-dispatcher 的 TICKETS_SERVICE）。 */
export const TICKETS_SERVICE = 'dispatcher/tickets';

/** 票库默认位置；dispatcher 的 store.file 通常也是这个路径。 */
export const DEFAULT_TICKETS_DB = path.join(os.homedir(), '.dsh', 'dispatcher', 'tickets.db');

/** 未终态的四态：任意一张存在就算票台不空。 */
export const OPEN_STATUSES = Object.freeze(['open', 'running', 'waiting', 'blocked']);

const OPEN = new Set(OPEN_STATUSES);

function errText(error) {
  return String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim() || '没拿到原因';
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 轮空日志（固定文案，grep `[ego] 轮空` 就能数出来）。 */
export function formatBusyLog(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return `[ego] 轮空：票台有 ${n} 张未终态票（open/running/waiting/blocked）`;
}

/** 查不到票台时的日志：也带 `[ego] 轮空` 前缀，但说清是按不空处理。 */
export function formatUnknownLog(reason) {
  return `[ego] 轮空：票台查不到（${oneLine(reason) || '没拿到原因'}），按不空处理`;
}

/**
 * 探针读数日志：每拍一行，`source=` 只有 service / sqlite / none 三种取值。
 * 括号里带两个源各自读到什么（或为什么没拿到），方便对账到底谁说了 0。
 */
export function formatProbeLog(result) {
  const source = result?.source === 'service' || result?.source === 'sqlite' ? result.source : 'none';
  const count = Math.max(0, Math.floor(Number(result?.count) || 0));
  const detail = oneLine(result?.detail).slice(0, 160);
  return `[ego] 票台探针 source=${source} count=${count} busy=${result?.busy ? 1 : 0}${detail ? `（${detail}）` : ''}`;
}

/**
 * 从 dispatcher/tickets 服务的读数里数未终态票。
 * payload 是最稳的形状（CLI 和快照文件都从它出）；没有 payload 的老/别的实现
 * 退到 select({ open: true })。两样都没有就当查不到——别猜。
 */
export function countOpenFromService(service) {
  if (!service || typeof service !== 'object') throw new Error(`没有 ${TICKETS_SERVICE} 服务`);
  if (typeof service.payload === 'function') {
    const payload = service.payload({ open: true });
    const counts = payload?.counts;
    if (counts && Number.isFinite(Number(counts.openTotal))) {
      return Math.max(0, Number(counts.openTotal));
    }
    if (Array.isArray(payload?.tickets)) {
      return payload.tickets.filter((ticket) => OPEN.has(ticket?.status)).length;
    }
    throw new Error('payload 里没有 counts.openTotal');
  }
  if (typeof service.select === 'function') {
    const views = service.select({ open: true });
    if (!Array.isArray(views)) throw new Error('select 没返回数组');
    return views.filter((ticket) => OPEN.has(ticket?.status)).length;
  }
  throw new Error('服务没有 payload/select');
}

/**
 * 只读打开票库数未终态票。调用方负责兜错（这里只管把原因抛清楚）。
 * node:sqlite 是 Node 22.5+ 的内置模块；拿不到时抛错，上层按不空处理。
 *
 * 别加 `immutable=1`：readOnly 本身实测能读到尚未 checkpoint 的 -wal（实测
 * 用「写连接不关、另起子进程只读」复验过），immutable=1 才会把 -wal 当不存在、
 * 读出一份过期甚至没有表的视图。
 */
export async function countOpenFromDb(file = DEFAULT_TICKETS_DB) {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    throw new Error(`node:sqlite 不可用：${errText(error)}`);
  }
  const DatabaseSync = sqlite?.DatabaseSync;
  if (typeof DatabaseSync !== 'function') throw new Error('node:sqlite 没有 DatabaseSync');

  let db;
  try {
    // readOnly：不建库、不写 WAL、不拿写锁；库不在就直接抛，交给上层按不空处理
    db = new DatabaseSync(file, { readOnly: true });
    const placeholders = OPEN_STATUSES.map(() => '?').join(', ');
    const row = db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE state IN (${placeholders})`).get(...OPEN_STATUSES);
    return Math.max(0, Number(row?.c) || 0);
  } finally {
    try {
      db?.close?.();
    } catch {
      /* 关库失败不影响读数 */
    }
  }
}

/**
 * 建一个「这一拍票台忙不忙」的探针。
 *
 * 两个来源都读一遍，`count = max(service, sqlite)`：
 *   · 只有一个源能读，就用它；
 *   · 两个都读了，取大的（保守）；
 *   · 两个都读不到 → `{ busy: true, unknown: true, source: 'none' }`，tick 那边照样轮空。
 * 无论结果如何都带回 `detail`，供 formatProbeLog 留一行可对账的痕迹。
 *
 * @param {{
 *   ctx?: object,
 *   dbPath?: string,
 *   readService?: () => object|undefined,
 *   readDb?: () => number|Promise<number>,
 * }} [options]
 * @returns {() => Promise<{busy: boolean, count: number, source: 'service'|'sqlite'|'none', unknown?: boolean, error?: string, detail?: string}>}
 */
export function createTicketProbe({ ctx, dbPath = DEFAULT_TICKETS_DB, readService, readDb } = {}) {
  const read = typeof readService === 'function' ? readService : () => probed(ctx, TICKETS_SERVICE);
  const readDbCount = typeof readDb === 'function' ? readDb : () => countOpenFromDb(dbPath);

  return async function probeTickets() {
    let service;
    let serviceError = '';
    try {
      service = read();
    } catch (error) {
      service = undefined;
      serviceError = `读 ${TICKETS_SERVICE} 服务失败：${errText(error)}`;
    }

    let serviceCount = null;
    if (service) {
      try {
        serviceCount = countOpenFromService(service);
      } catch (error) {
        serviceError = `${TICKETS_SERVICE} 读数失败：${errText(error)}`;
      }
    } else if (!serviceError) {
      serviceError = `没有 ${TICKETS_SERVICE} 服务`;
    }

    let dbCount = null;
    let dbError = '';
    try {
      dbCount = await readDbCount();
    } catch (error) {
      dbError = `读库失败：${errText(error)}`;
    }

    const detail = [
      serviceCount === null ? `service 没拿到：${serviceError || '没拿到原因'}` : `service=${serviceCount}`,
      dbCount === null ? `sqlite 没拿到：${dbError || '没拿到原因'}` : `sqlite=${dbCount}`,
    ].join('／');

    if (serviceCount === null && dbCount === null) {
      return {
        busy: true,
        unknown: true,
        count: 0,
        source: 'none',
        error: `${serviceError || '没有票台服务'}；${dbError || '读库失败'}`,
        detail,
      };
    }

    const count = Math.max(serviceCount ?? 0, dbCount ?? 0);
    // 同分时算 service：服务是首选源，日志里 source 也就三个取值，好 grep
    const source = serviceCount === count ? 'service' : 'sqlite';
    return { busy: count > 0, count, source, detail };
  };
}
