/**
 * 对象存在性核查（规则第七节 GA3/GA4 里「本地文件」那半）。
 *
 * 只做机械核：路径在不在、读不读得到、跳不跳得出允许根、锚点行号越不越界。
 * 记忆 / 票 / 会话 / 服务 / 外部资料 / 外部仓库这几类要运行时上下文（recall 结果、
 * state.lastTicket、host_status、网络），这一批**返回 unsupported**，不当成「不存在」——
 * 把 unsupported 当 false 会把好点子全拒了。
 *
 * 本文件不被 gate.js import，也不进线上路径；接线是第 3 批的事。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FILE_LINE_PATTERN } from './gate.js';

/** 核查结果的三种「有结论」状态 + 两种补充状态（规则 GA3/GA4/GA5）。 */
export const EXIST_STATUS = Object.freeze({
  OK: 'ok', // 存在且可读
  MISSING: 'missing', // 路径不存在
  DENIED: 'denied', // 在允许根外 / .git 内 / 不可读
  INVALID: 'invalid', // 入参不成立（空 kind、空 value、扩展名不对）
  UNSUPPORTED: 'unsupported', // 这一类这一批不查
});

/**
 * 允许根（规则第四节 files 那行）：仓库根、`~/.dsh`、`~/.dsh-ego`。
 * 用 homedir / DSH_EGO_ROOT 拼，不写死本机路径；调用方可以整个覆盖。
 */
export const DEFAULT_ROOTS = Object.freeze([
  process.env.DSH_EGO_ROOT || path.join(os.homedir(), 'fatfish'),
  path.join(os.homedir(), '.dsh'),
  path.join(os.homedir(), '.dsh-ego'),
]);

/** config 类只认这四种配置文件的扩展名（规则第四节 config 那行）。 */
export const CONFIG_EXTENSIONS = Object.freeze(['.yml', '.yaml', '.json', '.toml']);

/** 本地能自查的两类；其余类走 unsupported。 */
const LOCAL_KINDS = new Set(['files', 'config']);

/** `~` / `~/x` 展开；相对路径按 cwd 落成绝对路径。 */
export function resolveLocalPath(value, { cwd = process.cwd() } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(cwd, raw);
}

/** target 是不是落在 root 里面（按路径段判，`/a/bc` 不算在 `/a/b` 里）。 */
function isInside(root, target) {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** roots 归一：展开 `~` → 绝对路径 → 尽力量 realpath（根自己不存在就用绝对路径）。 */
async function resolveRoots(roots) {
  const list = Array.isArray(roots) ? roots : DEFAULT_ROOTS;
  const resolved = [];
  for (const root of list) {
    const abs = resolveLocalPath(root);
    if (!abs) continue;
    try {
      resolved.push(await fs.realpath(abs));
    } catch {
      resolved.push(abs);
    }
  }
  return resolved;
}

/** 路径里有没有一段叫 `.git`（规则 GA5：不许落在 .git/ 内）。 */
function inGitDir(target) {
  return target.split(path.sep).includes('.git');
}

/** 统一的结果形状：`ok` 只认 true，unsupported 给 null（不是 false）。 */
function result(status, { kind, value, resolved = '', reason = '' } = {}) {
  return {
    status,
    ok: status === EXIST_STATUS.OK ? true : status === EXIST_STATUS.UNSUPPORTED ? null : false,
    kind,
    value,
    path: resolved,
    reason,
  };
}

/**
 * 按 object 类型核查存在性。
 *
 * @param {{kind?: string, value?: string}} object stage2 方案里的 `object`（GA3 的输入）
 * @param {{roots?: string[], cwd?: string}} [options] roots 覆盖允许根（第 3 批从配置拿）
 * @returns {Promise<{status: string, ok: boolean|null, kind: string, value: string, path: string, reason: string}>}
 *   `status='ok'` 才是存在；`unsupported` 表示这一类这一批没查（ok 为 null，别当真假用）
 */
export async function checkExists(object, { roots = DEFAULT_ROOTS, cwd = process.cwd() } = {}) {
  const kind = String(object?.kind ?? '').trim();
  const value = String(object?.value ?? '').trim();
  if (!kind) return result(EXIST_STATUS.INVALID, { kind, value, reason: 'object.kind 是空的' });
  if (!value) return result(EXIST_STATUS.INVALID, { kind, value, reason: 'object.value 是空的' });
  if (!LOCAL_KINDS.has(kind)) {
    return result(EXIST_STATUS.UNSUPPORTED, {
      kind,
      value,
      reason: `${kind} 类要运行时上下文（recall / state / host_status / 网络），这一批不查`,
    });
  }

  const abs = resolveLocalPath(value, { cwd });
  let real;
  try {
    real = await fs.realpath(abs);
  } catch {
    return result(EXIST_STATUS.MISSING, { kind, value, resolved: abs, reason: '路径不存在（realpath 失败）' });
  }

  const allowed = await resolveRoots(roots);
  if (!allowed.some((root) => isInside(root, real))) {
    return result(EXIST_STATUS.DENIED, { kind, value, resolved: real, reason: 'realpath 后不在允许根内' });
  }
  if (inGitDir(real)) {
    return result(EXIST_STATUS.DENIED, { kind, value, resolved: real, reason: '路径落在 .git/ 里' });
  }
  try {
    await fs.access(real, fs.constants.R_OK);
  } catch {
    return result(EXIST_STATUS.DENIED, { kind, value, resolved: real, reason: '文件在允许根内但读不到' });
  }
  if (kind === 'config') {
    const ext = path.extname(real).toLowerCase();
    if (!CONFIG_EXTENSIONS.includes(ext)) {
      return result(EXIST_STATUS.INVALID, {
        kind,
        value,
        resolved: real,
        reason: `不是配置文件（扩展名 ${ext || '无'}，只认 ${CONFIG_EXTENSIONS.join('/')}）`,
      });
    }
  }
  return result(EXIST_STATUS.OK, { kind, value, resolved: real });
}

/** 数一个文件有多少行：空文件 0 行，末尾换行不多算一行。 */
function countLines(content) {
  if (!content) return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

/**
 * 核查「文件:行号」锚点（规则 GA4）：文件在允许根内、行号（或区间两端）不超过总行数。
 *
 * @param {string} anchor `lib/gate.js:36` / `x.js:36-40`
 * @param {{roots?: string[], cwd?: string}} [options]
 * @returns {Promise<{status: string, ok: boolean|null, anchor: string, path: string, from: number, to: number,
 *   totalLines: number, reason: string}>} `from`/`to` 是解析出来的行号，没解析出来是 0
 */
export async function checkFileLine(anchor, { roots = DEFAULT_ROOTS, cwd = process.cwd() } = {}) {
  const raw = String(anchor ?? '').trim();
  const base = { anchor: raw, path: '', from: 0, to: 0, totalLines: 0 };
  const match = raw.match(FILE_LINE_PATTERN);
  if (!match) return { status: EXIST_STATUS.INVALID, ok: false, ...base, reason: '不是「文件:行号」形状' };

  const text = match[0];
  const cut = text.lastIndexOf(':');
  const file = text.slice(0, cut);
  const parts = text
    .slice(cut + 1)
    .split('-')
    .map((n) => Number(n));
  const from = parts[0];
  const to = parts.length > 1 ? parts[1] : parts[0];
  const exists = await checkExists({ kind: 'files', value: file }, { roots, cwd });
  if (exists.status !== EXIST_STATUS.OK) return { ...exists, anchor: raw, from, to };
  if (!(from >= 1) || !(to >= from)) {
    return { status: EXIST_STATUS.INVALID, ok: false, ...base, path: exists.path, from, to, reason: '行号不成立' };
  }

  let content;
  try {
    content = await fs.readFile(exists.path, 'utf8');
  } catch {
    return { status: EXIST_STATUS.DENIED, ok: false, ...base, path: exists.path, from, to, reason: '读不到文件内容' };
  }
  const totalLines = countLines(content);
  if (to > totalLines) {
    return {
      status: EXIST_STATUS.MISSING,
      ok: false,
      ...base,
      path: exists.path,
      from,
      to,
      totalLines,
      reason: `行号 ${to} 超过总行数 ${totalLines}`,
    };
  }
  return { status: EXIST_STATUS.OK, ok: true, ...base, path: exists.path, from, to, totalLines, reason: '' };
}
