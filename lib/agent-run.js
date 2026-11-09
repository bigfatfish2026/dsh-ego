/**
 * 两段（提议器 / 裁决器）共用的跑腿封装：
 *   建 agent → 塞提示词 → 等它一轮跑完 → 从 session 里取 assistant 文本
 *   → 解析 JSON → finally dispose（带硬超时）。
 *
 * 为什么每一处都要 try/finally + 超时：dispose 只注销 agent、把 session 从活表里摘掉，
 * **不删 sessions 目录里的文件**（每跑一段就留一个目录，攒起来很可观）。
 * 漏一次 dispose 就是永久垃圾，所以无论超时、抛错、进程正常走完，都走同一条 finally。
 *
 * deps 全部可注入，单测里给假 create / 假 timer，一条都不会真连模型。
 *
 * setup 的返回值有硬契约：宿主是 dsh-agent-loop 的
 * `const setupCommit = await setup?.(...); setupCommit?.commit();`
 * （0.2.2-rc.1 lib/index.js:1574-1576）。返回值要么 void，要么是带 commit() 的
 * AgentSetupCommit（dsh-agent lib/types/index.d.ts:23-40）——**不能**把
 * tools.restrict() 的 disposer 直接返回，那是个函数，上面没有 commit。
 */
import { randomUUID } from 'node:crypto';

/**
 * 提议器硬超时：它要翻记忆、翻文件，一轮里可能跑十几次工具往返。
 * 实测 effort=low 时一轮也会打十几次请求、每次几秒，120 秒很容易被掐；
 * 默认给 10 分钟，别让工具往返把点子掐掉。
 */
export const PROPOSER_TIMEOUT_MS = 600_000;
/** 裁决器硬超时：只看一段文字，给 3 分钟够翻记忆了 */
export const JUDGE_TIMEOUT_MS = 180_000;

/** 超时写成给人看的话：1000 以上按秒，不到一秒按毫秒 */
export function timeoutText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 秒';
  return n >= 1000 ? `${Math.round(n / 1000)} 秒` : `${Math.round(n)} 毫秒`;
}

/** 日志里怎么称呼这一段：提议器 / 裁决器，别的 kind 原样用 */
export function stageLabel(kind) {
  if (kind === 'proposer') return '提议器';
  if (kind === 'judge') return '裁决器';
  return String(kind || 'agent');
}

/**
 * 从一段模型回复里抠第一个平衡的 JSON 对象。
 * 模型爱包 ```json 围栏、爱在前后加两句废话，这里只认括号配对（字符串里的括号不算）。
 * @returns {object|null} 解析不出来的都当 null，调用方记失败
 */
export function extractJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(s.slice(start, i + 1));
          return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function streamText(stream) {
  if (!Array.isArray(stream)) return '';
  const parts = [];
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) parts.push(record.texts.join(''));
    else if (record.type === 'chunk' && record.chunk?.type === 'text-delta') parts.push(String(record.chunk.text ?? ''));
  }
  return parts.join('');
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('');
}

/**
 * 从一段 session 事件里挑出「这次跑的最终回答」。
 * 规则和 dsh-subagent 一致：最后一条非空 assistant 消息优先，没有再退回拼流式增量。
 */
export function assistantText(events = []) {
  let message;
  const partial = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (Array.isArray(content) && content.length > 0) message = content;
      partial.push(streamText(event.data?.stream));
    } else if (event.type === 'assistant/attempt') {
      partial.push(streamText(event.data?.stream));
    }
  }
  if (message !== undefined) return contentText(message);
  return partial.join('');
}

/**
 * 用「子 agent 自己的视角」筛白名单。
 *
 * 为什么不能用 ctx.tools.executable(name)：那是**执行**判据，不是存在判据。
 * dsh-tools 的 executable(name)（不带 toolSet 时）对带 when 条件的注册
 * 一律返回 undefined，而 web_search/web_fetch 正是条件注册——按它筛会把真工具筛掉。
 * 存在性看 get(name, scope)，它就是 view(scope).visible，条件注册也在里面。
 *
 * 为什么必须在 setup(childCtx, agent) 里做，不能在 apply 时做：插件 apply 的先后
 * 由依赖就绪顺序决定，不是配置行顺序；apply 那一刻别的插件可能还没 register
 * （实测裸 base 组合下 apply 时全局可见 0 条，3 秒后 25 条）。
 *
 * @param {object} tools 子 agent ctx 上的 tools 服务
 * @param {object} scope 子 agent 自己（setup 的第二个参数）
 * @param {string[]} allow 配置里写的白名单
 * @returns {{allow: string[], unknown: string[]}}
 */
export function selectAllow(tools, scope, allow) {
  const list = Array.isArray(allow) ? allow.map(String) : [];
  const kept = [];
  const unknown = [];
  for (const toolName of list) {
    if (typeof tools?.get !== 'function') {
      // 老宿主没有 get：宁可不筛，也别把名字全当成不存在
      kept.push(toolName);
      continue;
    }
    let visible = false;
    try {
      visible = Boolean(tools.get(toolName, scope));
    } catch {
      // get 抛错（scope 不认、服务在收尾）：按可见处理，交给 restrict 判
      visible = true;
    }
    if (visible) kept.push(toolName);
    else unknown.push(toolName);
  }
  return { allow: kept, unknown };
}

/**
 * 0 = 不设上限。宿主的 assertAgentOptions 会拒掉 `maxTokens <= 0`
 * （TypeError: agent maxTokens must be a positive safe integer），
 * 所以「不限」不能写 0 传下去，只能**不写这个键**。
 */
export const UNLIMITED_MAX_TOKENS = 0;

/**
 * 只把有值的路由字段塞进 agentOptions（空串会让路由解析难堪）。
 *
 * maxTokens 不传 ≠ 用模型声明的上限：宿主链路里 undefined 就不写，
 * 也就是说请求体里根本没有 max_tokens 字段，交给服务端默认。
 * 实测：同一段 construct 里不给 maxTokens，params 没有 max_tokens 键；
 * 给 2000 才有 {"max_tokens":2000}。
 */
/**
 * 推理档位白名单。宿主 schema 不校验值，写个 medium 照样往下传，到服务端才炸。
 * 所以这里自己拦：只认 low/high/max（与 cordis.patch.yml 的 reasoningEfforts 一致），
 * 别的值当没填，请求里就不带这个键。
 */
export const REASONING_EFFORTS = ['low', 'high', 'max'];

/** 归一化档位：合法就返回小写值，空/非法返回空串（= 不传，走服务端默认） */
export function normalizeReasoningEffort(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return REASONING_EFFORTS.includes(s) ? s : '';
}

export function routeOptions({ provider, model, maxTokens, reasoningEffort }) {
  const out = {};
  if (provider) out.provider = String(provider);
  if (model) out.model = String(model);
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) out.maxTokens = Number(maxTokens);
  // 不传 = 服务端默认
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (effort) out.reasoningEffort = effort;
  return out;
}

/** 从 session 事件里取最后一次模型收尾原因（stop / max-tokens / error / aborted） */
export function finishKind(events = []) {
  let kind = '';
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const stream = event.data?.stream;
    if (!Array.isArray(stream)) continue;
    for (const chunk of stream) {
      if (chunk?.type === 'finish' && chunk.reason?.kind) kind = String(chunk.reason.kind);
    }
  }
  return kind;
}

/**
 * 正文为空时的报错：别只丢一句「没等到 assistant 文本」。
 *
 * 曾经出现过 maxTokens 给小了、预算被推理独占：finish=max-tokens、正文空，
 * 日志里却只写「没等到 assistant 文本」，看不出是预算截断。
 */
export function emptyReplyError(kind, stage = 'agent') {
  if (kind === 'max-tokens') {
    return (
      `模型把输出预算吃完了（finish=max-tokens），正文为空：这一段没设上限就检查服务端默认 max_tokens，` +
      `设了上限就调大 ${stage}.maxTokens`
    );
  }
  return `没等到 assistant 文本（finish=${kind || '未知'}，可能只出了推理没有正文）`;
}

/**
 * 跑一段临时 agent。
 *
 * @param {object} deps
 * @param {(options: object) => Promise<{agent: object, dispose: () => Promise<void>}>} deps.create
 *        建 agent 的函数（生产里是 ctx.agents.create，单测注入假的）
 * @param {(line: string) => void} [deps.log] 记日志
 * @param {() => number} [deps.now] 时间源（毫秒）
 * @param {() => string} [deps.uuid] id 源
 * @param {typeof setTimeout} [deps.setTimeout] 定时器（测试可换成立刻触发的假实现）
 * @param {typeof clearTimeout} [deps.clearTimeout]
 * @param {object} options
 * @param {string} options.kind proposer | judge（进日志、进 source）
 * @param {string} options.prompt 塞给它的那句 user 文本
 * @param {string[]} options.allow 工具白名单（setup 里 restrict 一次，多层取交集所以只用一处）
 * @param {number} options.timeoutMs 硬超时
 * @param {string} [options.sessionId] 裸 uuid；不给就新生成
 * @param {string} [options.agentPreset] 会话标记，便于以后从 sessions 目录里认出来清理
 * @param {object} [options.agentOptions] provider/model/maxTokens
 * @returns {Promise<{ok: true, text: string, sessionId: string, elapsedMs: number}
 *                 | {ok: false, error: string, sessionId?: string}>}
 */
export async function runAgent(deps, options) {
  const {
    kind = 'agent',
    prompt,
    allow = [],
    timeoutMs = PROPOSER_TIMEOUT_MS,
    sessionId = deps.uuid ? deps.uuid() : randomUUID(),
    agentPreset = 'dsh-ego',
    agentOptions = {},
  } = options ?? {};
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const started = now();
  const label = stageLabel(kind);
  // 开跑和耗时都记一行：下次看日志能直接分清是「Quick 还是慢」、是卡在工具往返还是卡在模型
  log(`${label}开跑（超时 ${timeoutText(timeoutMs)}）`);

  const abort = new AbortController();
  let timer;
  let handle;
  let work;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (!handle) return;
    try {
      await handle.dispose();
    } catch (error) {
      log(`[${kind}] dispose 失败（会留一个 sessions 目录）：${String(error?.message ?? error)}`);
    }
  };

  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimer(() => {
        const reason = new Error(`超时（${timeoutText(timeoutMs)}）`);
        try {
          abort.abort(reason);
        } catch {
          /* 已经 abort 过就算了 */
        }
        reject(reason);
      }, timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
    });

    const workPromise = (work = (async () => {
      if (typeof deps.create !== 'function') throw new Error('deps.create 不是一个函数');
      handle = await deps.create({
        sessionId,
        // 不带 parentAgent：临时 agent 不该跟着主会话一起被回收
        meta: { origin: 'subagent', agentPreset },
        agentOptions: routeOptions(agentOptions),
        signal: abort.signal,
        setup: (childCtx, childAgent) => {
          // 只在 setup 里 restrict 一次：多层 restrict 取交集，写两处只会更难懂
          if (!childCtx?.tools || typeof childCtx.tools.restrict !== 'function') {
            throw new Error('setup 拿到的 ctx 上没有 tools.restrict');
          }
          // 过滤也在这里做：此刻别的插件都注册完了，且用的是子 agent 自己的视角
          // （含它的 preset/祖先层），不会把「还没注册」误判成「不存在」
          const { allow: kept, unknown } = selectAllow(childCtx.tools, childAgent, allow);
          if (unknown.length > 0) {
            log(`[${kind}] 白名单里这些工具子 agent 看不见，已剔掉：${unknown.join(', ')}`);
          }
          // restrict 是**立即生效**的：dsh-tools 的 restrict 把过滤条件同步 append 进当前
          // agent scope 的 layer，返回的只是解除限制的 disposer，没有「待生效」的状态。
          // 所以这里调完限制就挂上了；那个 disposer 也不用留——agent scope 卸载时
          // 限制跟着走。
          try {
            childCtx.tools.restrict({ allow: kept });
          } catch (error) {
            // restrict 因为未知名抛错不该把整段弄挂：退回空名单，这一段只跑提示词
            log(`[${kind}] restrict 被拒（${String(error?.message ?? error).slice(0, 200)}），这一段这个 agent 不带工具跑`);
            childCtx.tools.restrict({ allow: [] });
          }
          // 返回值必须是 AgentSetupCommit（可选返回，但一旦返回对象就**必须**带 commit）：
          // 宿主是 `const setupCommit = await setup?.(...); setupCommit?.commit();`。
          // 旧版把 restrict 的 disposer（一个函数，上面没有 commit）直接返回，
          // 宿主会报「setupCommit?.commit is not a function」。
          // 契约见 dsh-agent 的 AgentSetupCommit / AgentSetup 类型。
          return {
            commit() {
              // 限制已在 setup 里即时生效，发布点没有待提交的东西，这里不重复 restrict
              // （多层 restrict 取交集，再挂一次只会更难懂也不更安全）。
              // 故意留空而不是可选链绕过：宿主调不调都要有个可调用的 commit。
            },
          };
        },
      });
      if (!handle || !handle.agent) throw new Error('create 没返回 agent');
      const agent = handle.agent;
      const from = Number(agent.session?.seq) || 0;
      agent.followup({
        id: deps.uuid ? deps.uuid() : randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: String(prompt ?? '') }],
        source: { kind: 'dsh-ego', agent: kind },
      });
      // followup 在 idle 的 agent 上是同步转 running 的（agent-loop 的 wakeDriver），
      // 所以这里 status 已经是 running；读不到 status 的假实现就照样等
      if (typeof agent.whenIdle === 'function') await agent.whenIdle();
      const events = typeof agent.session?.snapshotEvents === 'function'
        ? agent.session.snapshotEvents(from)
        : [];
      return { text: assistantText(events), events };
    })());

    const done = await Promise.race([workPromise, deadline]);
    const text = String(done?.text ?? '').trim();
    if (!text) throw new Error(emptyReplyError(finishKind(done?.events), kind));
    const elapsedMs = Math.max(0, now() - started);
    log(`${label}跑完，耗时 ${(elapsedMs / 1000).toFixed(1)} 秒`);
    return { ok: true, text: String(done.text), sessionId, elapsedMs };
  } catch (error) {
    const message = String(error?.message ?? error ?? '未知错误');
    log(`${label}失败，耗时 ${(Math.max(0, now() - started) / 1000).toFixed(1)} 秒：${message.slice(0, 200)}`);
    return { ok: false, error: message, sessionId };
  } finally {
    if (timer !== undefined) clearTimer(timer);
    // 超时那一路：work 可能还在跑。先 abort（create 会被放掉），再给它几秒收敛，
    // 等到了 handle 才能 dispose；等不到也不会永久占着 agent。
    try {
      abort.abort(new Error('runAgent 收尾'));
    } catch {
      /* 已 abort */
    }
    if (!handle && work) {
      let settle;
      const bounded = new Promise((resolve) => {
        settle = setTimer(resolve, 5_000);
        if (typeof settle?.unref === 'function') settle.unref();
      });
      await Promise.race([work.catch(() => {}), bounded]);
      if (settle !== undefined) clearTimer(settle);
    }
    await dispose();
  }
}
