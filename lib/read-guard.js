/**
 * 只读 helper 的敏感路径守卫。
 *
 * 2026-11-22 B 方案之后，ego 的 helper 会话（stage2 / judge / arbiter）走 dispatcher 的
 * worker 分支，ego 自己配的 allow 成为真上限，于是 read / glob / grep 真的能用了。
 * 但 dsh-tool-fs 的 read 没有路径级 deny：无人值守的提议器完全可以把
 * `~/.dsh/.env`、`~/.dsh/providers.json`、`~/.ssh/id_rsa` 读进提示词。
 *
 * dsh-tools 的 `ctx.tools.guard(fn)` 是官方拦截点（dsh-tools lib/index.js:649，guard 返回
 * 字符串即拒绝，见 types/contracts.d.ts 的 ToolGuard）。这里只做「最小黑名单」：
 *   · read / read_image：目标文件名命中凭据类名字，或落在 ~/.ssh 里 → 拒；
 *   · glob / grep：pattern / include 点名了凭据类文件 → 拒；搜索根是 home / `/` /
 *     ~/.dsh / ~/.ssh（或它们的祖先）→ 拒；搜索根下一层就摆着凭据文件 → 拒。
 *   ~/.dsh-ego 是自己的状态/日志，不拦；~/.dsh 只拦「从根往下搜」，profiles 下的配置照读。
 * 最小黑名单不是万能墙：grep 某个仓库深处藏着的 .env 仍可能被搜到（只查一层目录），
 * 这条残留写在 dispatch 报告里，靠「只读 + 有 gate/judge 兜底」压着。
 *
 * 这不是 gate 规则，不参与方案判定；它只保证 helper 的工具面拿不到凭据正文。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 会碰文件正文/文件名的只读工具；别的工具（memory_recall 等）不经过这里。 */
export const READ_GUARD_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep']);

/**
 * 凭据类文件名（basename 匹配，大小写不敏感）。宁可多拦：
 * 漏一个就是整份凭据进提示词，误拦一个只是让模型换条路。
 */
export const SENSITIVE_BASENAME_PATTERNS = Object.freeze([
  /^\.env(\..*)?$/i, // .env / .env.local / .env.secrets
  /^\.credentials\.ya?ml$/i,
  /^providers\.json$/i,
  /^auth\.json$/i,
  /^cookies?\.(json|txt)$/i,
  /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
]);

/** 整棵不许读的目录（相对 home）：只有私钥目录；ego 自己的 ~/.dsh-ego 是状态/日志，还要给自己看。 */
export const PROTECTED_HOME_DIRS = Object.freeze(['.ssh']);

/**
 * grep/glob 不许从这些根往下搜（相对 home）：~/.dsh 根下有 .env，
 * ~/.ssh 全是私钥。~/.dsh-ego 只有 ego 自己的状态与日志，留着给自指方向查。
 */
export const PROTECTED_SEARCH_HOME_DIRS = Object.freeze(['.dsh', '.ssh']);

/** 文件名命中凭据类黑名单时返回命中的模式原文，否则空串。 */
export function sensitiveBasename(name) {
  const base = path.basename(String(name ?? '').trim());
  if (!base) return '';
  for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
    if (pattern.test(base)) return String(pattern);
  }
  return '';
}

/** `~` / `~/x` 展开；相对路径按 cwd 落成绝对路径。 */
function absoluteOf(value, { home, cwd }) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

/** target 是不是在 dir 里（按路径段判，/a/bc 不算在 /a/b 里）。 */
function underDir(target, dir) {
  if (!target || !dir) return false;
  const base = dir.length > 1 && dir.endsWith(path.sep) ? dir.slice(0, -1) : dir;
  if (base === path.sep) return true; // 根目录下面的一切都算「在里面」
  return target === base || target.startsWith(`${base}${path.sep}`);
}

/**
 * 从 pattern / include 这类 glob 或正则文本里找凭据文件名。
 * `**\/.env`、`*.env`、`{a,b}/id_rsa` 都拆成词再看；开头的通配符先剥掉，
 * 免得 `*.env` 因为多了个 `*` 反而漏掉。
 */
function textNamesSensitive(value) {
  const text = String(value ?? '');
  if (!text) return '';
  const tokens = text.split(/[^A-Za-z0-9_.@*-]+/).filter(Boolean);
  for (const token of tokens) {
    const bare = token.replace(/^[*?\[\]{}]+/, '');
    if (!bare) continue;
    // 目录段也要看：`~/.dsh/.env`
    for (const part of bare.split('/')) {
      const hit = sensitiveBasename(part);
      if (hit) return hit;
    }
  }
  return '';
}

/** 目录下一层有没有凭据类文件（只查一层，代价小；深层的残留见文件头说明）。 */
function hasSensitiveChild(dir, fsApi) {
  try {
    const stat = fsApi.statSync(dir);
    if (!stat.isDirectory()) return '';
  } catch {
    return '';
  }
  let names;
  try {
    names = fsApi.readdirSync(dir);
  } catch {
    return '';
  }
  for (const name of Array.isArray(names) ? names : []) {
    const hit = sensitiveBasename(name);
    if (hit) return `${name}`;
  }
  return '';
}

/** 这些搜索根（或它们的祖先）一律不许 grep/glob：一层层搜下去必然扫到凭据。 */
function protectedSearchRoots({ home }) {
  return [
    { dir: home, why: 'home 根' },
    { dir: path.parse(home).root, why: '文件系统根' },
    ...PROTECTED_SEARCH_HOME_DIRS.map((name) => ({ dir: path.join(home, name), why: `~/${name}` })),
    ...PROTECTED_HOME_DIRS.map((name) => ({ dir: path.join(home, name), why: `~/${name}` })),
  ];
}

/**
 * 一次工具调用要不要拦。返回拒绝原因（给模型看的中文短句）或 undefined（放行）。
 *
 * @param {{name?: string, arguments?: unknown, agent?: object}} exec dsh-tools 的 ToolExecution
 * @param {{home?: string, cwd?: string, fsApi?: object}} [options]
 * @returns {string|undefined}
 */
export function readGuardDecision(exec, { home = os.homedir(), cwd = process.cwd(), fsApi = fs } = {}) {
  const name = String(exec?.name ?? '');
  if (!READ_GUARD_TOOLS.includes(name)) return undefined;
  const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  const sessionCwd = String(exec?.agent?.session?.header?.cwd ?? '').trim() || cwd;
  const deny = (why) => `只读 helper 不许碰凭据类路径：${why}`;

  if (name === 'read' || name === 'read_image') {
    const target = absoluteOf(args.file_path ?? args.path, { home, cwd: sessionCwd });
    if (!target) return deny('没写 file_path');
    const hit = sensitiveBasename(target);
    if (hit) return deny(`目标是 ${path.basename(target)}`);
    if (PROTECTED_HOME_DIRS.some((dir) => underDir(target, path.join(home, dir)))) {
      return deny(`${target} 在受保护目录里`);
    }
    return undefined;
  }

  // glob / grep：先看 pattern / include 有没有点名凭据文件
  for (const field of ['pattern', 'include']) {
    const hit = textNamesSensitive(args[field]);
    if (hit) return deny(`${field} 点名了凭据类文件（${path.basename(String(args[field]))}）`);
  }
  const root = absoluteOf(args.path, { home, cwd: sessionCwd }) || sessionCwd;
  for (const one of protectedSearchRoots({ home })) {
    // 根等于受保护区、或比它更靠上（会连它一起搜）都拒
    if (root === one.dir || underDir(one.dir, root)) return deny(`搜索根 ${root} 覆盖了${one.why}`);
  }
  const child = hasSensitiveChild(root, fsApi);
  if (child) return deny(`搜索根下一层就有凭据文件（${child}）`);
  return undefined;
}

/**
 * 把守卫挂到 helper 的 agent ctx 上（setup 里调，scope 跟着 agent 走）。
 * 宿主没有 tools.guard 时静默跳过：老宿主行为不变，只是没有这道保险。
 *
 * @param {{tools?: {guard?: Function}}} childCtx setup 拿到的子 agent ctx
 * @param {{log?: (line: string) => void, kind?: string, home?: string}} [options]
 */
export function installReadGuard(childCtx, { log = () => {}, kind = 'agent', home = os.homedir() } = {}) {
  const tools = childCtx?.tools;
  if (!tools || typeof tools.guard !== 'function') return;
  tools.guard((exec) => {
    const why = readGuardDecision(exec, { home });
    if (!why) return undefined;
    try {
      log(`[${kind}] read_guard:${String(exec?.name ?? '')}｜${why}`);
    } catch {
      /* 日志写不了也不影响拦截 */
    }
    return why;
  });
}
