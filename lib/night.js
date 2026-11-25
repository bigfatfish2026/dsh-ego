/**
 * 夜间模式：安静时段照常跑提议+裁决，但两个出口换掉。
 *
 *   ask → 写进 dsh-backlog 的工单池（status=待办），第二天等人定；
 *   do  → 进 nightTicket 队列（**不过期**），早上窗口一开、主会话 idle 时
 *         才按顺序向主会话提开票申请，开一张记一张。
 *
 * 为什么必须换出口：
 *   · 白天的 do 是「向主会话 followup 一条开票申请」，主会话不在活表就进
 *     state.pendingTicketQueue，30 分钟后被 prunePending 清掉（route.js:211-221 +
 *     round.js 的 prunePending）——夜里人在睡，这一条会真丢活；
 *   · 白天的 ask 是「followup 一句话」，夜里没人看，且没有等回应的状态机。
 *
 * 落盘走 dsh-backlog 自己的存储层（BacklogStore），不新造一份平行写库代码：
 * 表结构、id 形状（bl-<base36 时间>-<4 hex>）、四档状态校验、ticket_ids 合并
 * 全在那边，这里只负责拼 title/note 和去重标记。存储层是 dynamic import，
 * 路径默认同机安装位置，DSH_EGO_BACKLOG_STORE 可覆盖（写法照 lib/window.js
 * 读 dsh-price-clock 的那段）。每次写完立刻 close，不长期占写连接。
 *
 * 三条硬约束：
 *   1. 写池失败绝不许把夜间拍打崩：失败只记 state.nightInbox + 一行日志；
 *   2. 同一条 ask 不重复入池：note 里的 `night:<hash12>` 标记 + 写前扫一遍池；
 *   3. 纯拼装函数（hash/行/摘要/闸）全部可单测，不碰 sqlite。
 */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** 夜间队列的 pending 类型（pending-queue.js 的 QUEUE_FIELD 里登记，不过期） */
export const NIGHT_QUEUE = 'nightTicket';

/** note 里那行来源标记：清理/回溯都按这个串 grep */
export const NIGHT_SOURCE = '来源=ego夜间';

/** 夜间 ask 落池的状态：工单池只有四档，没有「待决定」，用待办 + 来源标记区分 */
export const NIGHT_ASK_STATUS = '待办';

/** 标题最多几个字（工单池列表是按标题扫的，别把整段裁决塞进去） */
export const ASK_TITLE_MAX = 40;

/** 夜间账本上限：只给早上的汇总用，超了丢最旧的 */
export const JOURNAL_LIMIT = 200;

/** 汇总消息的字数上限（一条 followup，别刷屏） */
export const DIGEST_MAX_CHARS = 300;

/** state.nightInbox 上限：写池失败的兜底收件箱 */
export const INBOX_LIMIT = 50;

/**
 * dsh-backlog 存储层的默认路径。跟 lib/window.js 的 PRICE_CLOCK_PATH 一个口径：
 * 默认按 os.homedir() 拼，环境变量覆盖，不写死某台机器的路径。
 */
export const DEFAULT_BACKLOG_STORE = process.env.DSH_EGO_BACKLOG_STORE
  || path.join(os.homedir(), 'fatfish', 'plugins', 'dsh-backlog', 'lib', 'store.js');

const pad = (n) => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD（跟 window.js 的 ymd 同形状，不 import 免得绕圈） */
export function nightDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 「这一夜」的账期键：跨午夜的那一段算同一夜。
 * 23:40 进窗口、00:05 还在窗口里——按日历日算会在 0 点把「每夜上限」的计数清零，
 * 所以窗口跨午夜（start > end）时，天亮之前都记在前一天头上。
 *
 * @param {Date} date 现在
 * @param {{quietStart?: number, quietEnd?: number}} cfg 配置（只读这两个值）
 */
export function nightKeyOf(date, cfg = {}) {
  const start = Number(cfg.quietStart);
  const end = Number(cfg.quietEnd);
  const crossesMidnight = Number.isFinite(start) && Number.isFinite(end) && start > end;
  if (crossesMidnight && date.getHours() < end) {
    const before = new Date(date.getTime());
    before.setDate(before.getDate() - 1);
    return nightDay(before);
  }
  return nightDay(date);
}

/** 按字符截断（不切坏代理对） */
export function clip(value, max) {
  const chars = [...String(value ?? '').replace(/\s+/g, ' ').trim()];
  if (!(max > 0) || chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** 单行化 */
export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 去重哈希：同一条 ask（提议原文 + 裁决那句话都没变）在池里只留一条。
 * 12 位十六进制够用，也短到能塞进 note 一行。
 */
export function askHash({ idea = '', text = '' } = {}) {
  return createHash('sha256').update(`${oneLine(idea)}\u0000${oneLine(text)}`).digest('hex').slice(0, 12);
}

/** note 里的去重标记 */
export function askMarker(hash) {
  return `night:${String(hash ?? '')}`;
}

/** 标题前缀：工单池列表里一眼能看出是夜里记的，清理时按它筛 */
export const ASK_TITLE_PREFIX = '[夜] ';

/**
 * 把一次夜间 ask 拼成工单池的一行。
 * 备注写清四样：来源、裁决理由、提议原文、裁决那句话——第二天不用回翻日志。
 */
export function buildAskRow({ text = '', idea = '', why = '', reason = '', hash = '', now = 0 } = {}) {
  const say = oneLine(text);
  const theIdea = oneLine(idea);
  const theWhy = oneLine(why);
  const theReason = oneLine(reason);
  const dedupe = String(hash || askHash({ idea, text }));
  // 前缀也算进标题预算：工单池列表按列宽排版，别让前缀把它顶出去
  const title = ASK_TITLE_PREFIX + clip(say || theIdea || '夜里记下的一条待定', ASK_TITLE_MAX - ASK_TITLE_PREFIX.length);
  const note = [
    NIGHT_SOURCE,
    `裁决=ask`,
    `时间=${now > 0 ? new Date(now).toISOString() : ''}`,
    theReason ? `理由=${theReason}` : '',
    theIdea ? `提议=${clip(theIdea, 180)}` : '',
    theWhy ? `why=${clip(theWhy, 180)}` : '',
    `原文=${clip(say, 200)}`,
    askMarker(dedupe),
  ].filter(Boolean).join('｜');
  return { title, status: NIGHT_ASK_STATUS, note, hash: dedupe };
}

/** 池里已有同一条 ask（按 note 里的标记比，不按标题比） */
export function asksInPool(items, hash) {
  const marker = askMarker(hash);
  return (Array.isArray(items) ? items : []).some((one) => String(one?.note ?? '').includes(marker));
}

/**
 * 每夜上限：max <= 0 = 不限（两档默认都是 2，见 lib/config.js）。
 * 留着这个开关是为了哪天想收口时改配置就行，不用再动代码。
 */
export function limitReached(used, max) {
  const line = Number(max);
  if (!Number.isFinite(line) || line <= 0) return false;
  return Number(used) >= line;
}

/**
 * 早上能不能把 nightTicket 提上去：窗口恢复 + 主会话在活表 + 空闲，三条同时成立。
 * 只看两个入参（纯函数，单测直接喂），真实调用方传 speakingWindow().ok 和 findAgent()。
 */
export function canDrainNight({ windowOk = false, agent = null } = {}) {
  if (!windowOk) return false;
  if (!agent) return false;
  return agent.status === undefined || agent.status === 'idle';
}

/**
 * 早上的那条汇总：一条 followup 说清昨夜记了几条待定、还压着几张申请、
 * 有几条到上限没记（跳过的也要报，不然主人以为只有眼前这些）。
 * 没东西可报就返回空串（调用方别发空消息）。
 */
export function buildDigestText({ entries = [], tickets = 0, inbox = 0, maxChars = DIGEST_MAX_CHARS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  // 去重命中（ask-duplicate）不计数：池里还是一条，别在汇总里报两遍
  const asks = list.filter((one) => one?.kind === 'ask');
  const failed = list.filter((one) => one?.kind === 'ask-failed');
  const dos = list.filter((one) => one?.kind === 'do');
  // 到每夜上限被拦下的条目：只记了日志，工单池/队列里都没有，汇总里必须说出来
  const skippedAsk = list.filter((one) => one?.kind === 'ask-skipped');
  const skippedDo = list.filter((one) => one?.kind === 'do-skipped');
  const queued = Number(tickets) || 0;
  const inboxCount = Number(inbox) || 0;
  const skipped = skippedAsk.length + skippedDo.length;
  if (asks.length === 0 && dos.length === 0 && queued === 0 && failed.length === 0 && inboxCount === 0 && skipped === 0) {
    return '';
  }
  const heads = [...new Set(asks.map((one) => clip(one.title || one.text || '', 18)).filter(Boolean))].slice(0, 3);
  const parts = [];
  if (asks.length > 0) {
    parts.push(`记了 ${asks.length} 条待你定（${heads.join('；')}${asks.length > heads.length ? '…' : ''}）`);
  }
  if (dos.length > 0) parts.push(`昨夜攒了 ${dos.length} 张待开票的活`);
  if (queued > 0) parts.push(`还有 ${queued} 张开票申请没递出去，等我提给主会话`);
  if (failed.length > 0 || inboxCount > 0) {
    parts.push(`${Math.max(failed.length, inboxCount)} 条没写进工单池，先记在本地收件箱`);
  }
  if (skipped > 0) {
    const detail = [
      skippedAsk.length > 0 ? `待你定 ${skippedAsk.length} 条` : '',
      skippedDo.length > 0 ? `待开票 ${skippedDo.length} 张` : '',
    ].filter(Boolean).join('、');
    parts.push(`另有 ${detail} 撞到每夜上限，没记也没排，日志里有据`);
  }
  return clip(`昨夜 ego：${parts.join('；')}。`, maxChars);
}

/**
 * 队列/台账满了挤掉最旧的那条时要留一行：不声不响地丢，事后没法对账。
 * 返回丢掉的条数（0 表示没满）。调用方自己 save + log。
 */
export function trimJournal(list, limit) {
  const items = Array.isArray(list) ? list : [];
  let dropped = 0;
  while (items.length > limit) {
    items.shift();
    dropped += 1;
  }
  return dropped;
}

/**
 * 夜间队列里有没有同一份活（按 goal+brief 逐字比）。
 *
 * 为什么要单独一个函数：pending-queue.js 的 findPendingTicketByContent 只查白天的
 * `ticket` 队列，route.js 的 ticketCallId 也只在那两个源里找 callId。夜里入队的是
 * `nightTicket`，同一条活被重判一次时 ticketCallId 会发一个新序号，于是同一份活
 * 在夜间队列里排成两条、各吃一张每夜额度（早上还会连着推两遍）。查这里就能沿用原 callId。
 */
export function findNightTicketByContent(state, { goal = '', brief = '' } = {}) {
  const queue = Array.isArray(state?.pendingNightTicketQueue) ? state.pendingNightTicketQueue : [];
  return (
    queue.find(
      (entry) => String(entry?.goal ?? '') === String(goal) && String(entry?.brief ?? '') === String(brief),
    ) ?? null
  );
}

/** 库文件路径：与 dsh-backlog 的 DEFAULT_DB_PATH 同一个落点，DSH_EGO_BACKLOG_DB 可覆盖 */
export const DEFAULT_BACKLOG_DB = process.env.DSH_EGO_BACKLOG_DB
  || path.join(os.homedir(), '.dsh', 'backlog', 'backlog.db');

/**
 * 打开 dsh-backlog 的存储层。dynamic import + 每次写完 close：
 * 长期开着写连接会跟主会话的 backlog_upsert 抢锁，没必要。
 */
export async function openBacklogStore({ storePath = DEFAULT_BACKLOG_STORE, dbPath = DEFAULT_BACKLOG_DB } = {}) {
  const target = /^[a-z]+:\/\//i.test(storePath) ? storePath : pathToFileURL(storePath).href;
  const mod = await import(target);
  const Store = mod?.BacklogStore;
  if (typeof Store !== 'function') throw new Error(`${storePath} 没有导出 BacklogStore`);
  return new Store(dbPath);
}

/**
 * 夜间池子的两件事：putAsk 落一条待定，attachTicket 把票号回填到对应工单。
 * openStore 可注入（单测给假实现，一个字节都不落盘）。
 *
 * @param {{storePath?: string, dbPath?: string, log?: (line: string) => void, openStore?: Function}} [options]
 */
export function createNightPool({
  storePath = DEFAULT_BACKLOG_STORE,
  dbPath = DEFAULT_BACKLOG_DB,
  log = () => {},
  openStore,
} = {}) {
  const open = typeof openStore === 'function' ? openStore : () => openBacklogStore({ storePath, dbPath });

  /**
   * 落一条 ask 进工单池。
   * @returns {Promise<{ok: boolean, id?: string, duplicate?: boolean, error?: string}>}
   */
  async function putAsk({ title, status = NIGHT_ASK_STATUS, note, hash = '' } = {}) {
    let store;
    try {
      store = await open();
      const items = store.list();
      if (hash && asksInPool(items, hash)) {
        const hit = items.find((one) => String(one?.note ?? '').includes(askMarker(hash)));
        return { ok: true, duplicate: true, id: String(hit?.id ?? '') };
      }
      const created = store.upsert({ title, status, note });
      return { ok: true, id: String(created?.id ?? ''), duplicate: false };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      try {
        store?.db?.close?.();
      } catch {
        /* close 失败不影响已经写进去的那条 */
      }
    }
  }

  /**
   * 拿到票号就回填到工单的 ticket_ids：先按 id 读出原行，再整行 upsert 回去。
   * 读不到那行（不是从池子里出的活）就返回 {ok:false}，不新建工单。
   */
  async function attachTicket({ backlogId = '', ticketId = '' } = {}) {
    const id = String(backlogId ?? '').trim();
    const ticket = String(ticketId ?? '').trim();
    if (!id || !ticket) return { ok: false, error: '缺 backlogId 或 ticketId' };
    let store;
    try {
      store = await open();
      const row = (store.list() || []).find((one) => String(one?.id ?? '') === id);
      if (!row) return { ok: false, error: `工单 ${id} 不在池里` };
      store.upsert({ id, title: row.title, status: row.status, note: row.note, tickets: [ticket] });
      return { ok: true, id };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      try {
        store?.db?.close?.();
      } catch {
        /* 同上 */
      }
    }
  }

  return { putAsk, attachTicket, storePath };
}

/** 从开票 goal 里认工单号（solution 动机的 goal 形如「执行已定方案 bl-xxx-yyyy：…」） */
export function backlogIdInGoal(goal) {
  const found = String(goal ?? '').match(/bl-[a-z0-9]+-[a-z0-9]+/);
  return found ? found[0] : '';
}
