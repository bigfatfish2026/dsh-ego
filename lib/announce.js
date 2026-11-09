/**
 * 开机自报：每次宿主重启、插件起来后，往主会话 followup 一句「醒了」。
 *
 * 规矩：
 *   · 只在这个进程上线时发一次（`announceOnStart`，默认开）；
 *   · 走跟裁决器 ask 完全同一条路（index 里传 `send = (text) => ask(text, now)`），
 *     所以 dryRun、privateOnly、目标会话不在活表就先存着这些行为全都继承下来；
 *   · 文本不是死模板：写的是「事实 + 给主会话的指令」，让主会话自己生成一句话，
 *     免得每次重启都是同一句；
 *   · 还没有目标会话就先不发，记一行日志；什么时候再试由 index 里的闸门
 *     （announce-gate.js）决定：等 agents 就绪信号，等不到再由兜底补一次。
 */

/**
 * 兜底等待上限，默认 10 秒。
 *
 * 名字里的 Delay 是历史包袱：早先这是「猜多久后发」，抖 20% 到 8~12 秒；
 * 现在开机自报等 `internal/service` 的 agents 就绪（见 announce-gate.js），
 * 这个值只用来当「等不到就按老路发一次」的上限，不再抖动。
 */
export const DEFAULT_ANNOUNCE_DELAY_MS = 10_000;

/** 兜底上限（毫秒）：非有限值或负数退回默认 10 秒，0 表示立刻兜底。 */
export function announceWaitMs(baseMs = DEFAULT_ANNOUNCE_DELAY_MS) {
  const base = Number(baseMs);
  if (!Number.isFinite(base) || base < 0) return DEFAULT_ANNOUNCE_DELAY_MS;
  return base;
}

/** 给主会话的短指令：只一句，说清「醒了，先看有没有该验的，没有就打个招呼」。 */
export const ANNOUNCE_INSTRUCTION = '刚重启完，先看有没有该验的事，有就去做，没有就跟用户打句招呼，短。';

/**
 * 给主会话的话：版本号 + 一句醒来的短指令，别写成要转述的长模板。
 *
 * **不写「下一拍」**：那个时间是插件加载那一刻算出来的旧值，
 * 排期一变它就成了假话。要报排期就等下一次真排完再说，别在自报里写死。
 * @param {{version?: string}} facts
 */
export function buildAnnounceText({ version = '' } = {}) {
  const head = `dsh-ego${version ? ` ${version}` : ''}`;
  return `${head} ${ANNOUNCE_INSTRUCTION}`;
}

/**
 * 日志里把「给主会话的指令」和「实际文本」分成两条，别混成一句。
 * @param {string} text
 * @returns {string[]}
 */
export function buildAnnounceLog(text) {
  return [
    `开机自报：给主会话的指令 = ${ANNOUNCE_INSTRUCTION}`,
    `开机自报：实际文本 = ${String(text ?? '')}`,
  ];
}

/**
 * 造一个「每进程最多成功报一次」的自报器。
 * @param {{
 *   enabled?: boolean,
 *   send: (text: string) => Promise<{ok: boolean, pending?: boolean, detail?: string}>,
 *   targetId?: () => string,
 *   log?: (line: string) => void,
 *   facts?: () => {version?: string},
 * }} options
 */
export function createAnnouncer(options = {}) {
  const {
    enabled = true,
    send,
    targetId = () => '',
    log = () => {},
    facts = () => ({}),
  } = options;

  let sent = false;

  async function announce() {
    if (!enabled) {
      log('开机自报：announceOnStart = false，这次不报');
      return { ok: false, skipped: true, reason: 'announceOnStart = false' };
    }
    if (sent) return { ok: false, skipped: true, reason: '这个进程已经报过一次' };
    const target = String(targetId?.() || '').trim();
    if (!target) {
      log('开机自报：还没有目标会话，这次不发（等用户在私聊里说一句，等不到就一直不发）');
      return { ok: false, skipped: false, reason: '没有目标会话' };
    }
    const text = buildAnnounceText(facts());
    let result;
    try {
      result = await send(text);
    } catch (error) {
      const detail = `开机自报抛错：${String(error?.message ?? error)}`;
      log(detail);
      return { ok: false, reason: detail };
    }
    if (result?.ok) {
      sent = true;
      for (const line of buildAnnounceLog(text)) log(line);
      log(`开机自报已发出（${target.slice(-8)}）`);
      return { ok: true, target, text };
    }
    log(`开机自报没发出去：${result?.detail ?? result?.reason ?? '未知'}`);
    return { ok: false, reason: result?.detail ?? result?.reason ?? '未知' };
  }

  return {
    announce,
    get sent() {
      return sent;
    },
  };
}
