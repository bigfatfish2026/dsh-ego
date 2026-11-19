/**
 * 读建议：把「读格该去读哪一处」变成候选行上的一行真实路径。
 *
 * 为什么要有这一层：stage1 的候选只有
 * `read.primitive` + `read.objectKind`，没有实例；素材只有一句方向描述。
 * 模型拿到「读 inspect×config」只能自己 glob 摸结构，7 次里 4 次空手。
 *
 * 做法：ego 自己在已知的几个根上扫一次，把**真实存在**的路径列进候选行，
 * 模型不扫目录。不做 KIND_READ_HINTS 静态常量表——静态表会过期、要人维护。
 *
 * 三条边界：
 *   · 轻：一次枚举只 readdir + stat 一层，不递归；不碰 node_modules；单个根出错跳过，
 *     不让整拍挂掉；进程内按 60 秒 TTL 缓存（createReadHintCache）。
 *   · 窄：config 只认 READ_ROOTS 里写的那几个位置，files 只认 logs 目录下的 *.log。
 *   · 可覆盖：配置 `proposer.readHints` 给了某个 objectKind，就整类替换枚举结果。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OBJECT_KINDS } from './grid.js';

/** 枚举结果的进程内缓存时长：一拍最多算一次，60 秒内复用。 */
export const READ_HINTS_TTL_MS = 60_000;

/** 每类最多列几条真实路径（config / files 各算各的）。 */
export const READ_HINTS_MAX_ITEMS = 5;

/**
 * 不给路径、只给读法的几类：这些类的对象没有「本机某个文件」这种实例，
 * 硬凑路径反而误导模型。
 */
export const READ_HINT_TEXT = {
  service: '用 host_status 看 CPU/内存/磁盘/温度这几栏，unit 列表拿不到',
  memory: 'memory_recall 按关键词翻，要看单个实体用 memory_entity',
  ticket: 'dispatch_list 看本会话名下的票',
  session: 'chat_recall 按关键词翻聊天记录',
  'external-doc': '种子关键词走 web_search',
  'external-repo': 'git -C 仓库目录 看 status 和同步状态',
  // 计划大纲：plans/ 目录可能还没建（第一次写方案前不存在），给读法而不是路径清单
  plan: '读 ~/fatfish/plans 下最近几份 backlog-*.md（没有就按工单现写）',
};

/** 枚举扫空的兜底一句（不列路径，但别让模型以为这一栏没意义）。 */
export const READ_HINT_EMPTY = {
  config: '（这几处没扫到 cordis.patch.yml / settings.yaml）',
  files: '（logs 目录没扫到 .log）',
};

/**
 * 默认根。只扫固定的一到两层，绝不递归：
 *   · config：~/.dsh/profiles/<name>/cordis.patch.yml、~/fatfish/plugins/<name>/cordis.patch.yml
 *     （`{ base, name }`：readdir 一次 base 拿子目录名，再 stat 那个子目录下的固定文件名），
 *     外加 ~/.dsh/settings.yaml（`{ file }`）；
 *   · files：~/fatfish/logs/*.log（`{ dir, match }`，按 mtime 取最近 5 个）。
 * 一个根就三种形状，不写 glob 字符串：走哪些目录是写死的，扫不到就跳过。
 *
 * @param {{home?: string}} [options]
 */
export function defaultReadRoots({ home = os.homedir() } = {}) {
  const fatfish = process.env.DSH_EGO_ROOT || path.join(home, 'fatfish');
  return {
    config: [
      { base: path.join(home, '.dsh', 'profiles'), name: 'cordis.patch.yml' },
      { base: path.join(fatfish, 'plugins'), name: 'cordis.patch.yml' },
      { file: path.join(home, '.dsh', 'settings.yaml') },
    ],
    files: [{ dir: path.join(fatfish, 'logs'), match: /\.log$/ }],
  };
}

/** objectKind 的别名 → 规范 id（`externalDoc` / `ext-doc` 都认成 `external-doc`）。 */
const KIND_ALIASES = new Map();
for (const kind of OBJECT_KINDS) {
  KIND_ALIASES.set(kind.id, kind.id);
  KIND_ALIASES.set(kind.key.toLowerCase(), kind.id);
}
KIND_ALIASES.set('ext-doc', 'external-doc');
KIND_ALIASES.set('ext-repo', 'external-repo');

/** 归一一个 objectKind 写法，认不出返回空串。 */
export function normalizeReadHintKind(value) {
  return KIND_ALIASES.get(String(value ?? '').trim().toLowerCase()) ?? '';
}

/** 一个根下一层文件的清单；根不存在 / 没权限 / 是 node_modules 都返回空数组，不抛。 */
function listRoot(rule, fsApi) {
  if (!rule || typeof rule !== 'object') return [];
  // `{ file }`：一个写死的绝对路径，存在才列
  if (rule.file) {
    const file = String(rule.file);
    if (!file || file.includes(`${path.sep}node_modules${path.sep}`)) return [];
    try {
      const st = fsApi.statSync(file);
      return st?.isFile?.() ? [{ path: file, name: path.basename(file), mtimeMs: Number(st.mtimeMs) || 0 }] : [];
    } catch {
      return [];
    }
  }
  // `{ base, name }`：base 下每个子目录里的固定文件名（profiles/<id>/cordis.patch.yml），
  // 固定两层，不递归。
  if (rule.base && rule.name) {
    const base = String(rule.base);
    const name = String(rule.name);
    if (!base || !name || base.includes(`${path.sep}node_modules${path.sep}`)) return [];
    let children;
    try {
      children = fsApi.readdirSync(base);
    } catch {
      return [];
    }
    const found = [];
    for (const rawChild of Array.isArray(children) ? children : []) {
      const child = String(rawChild ?? '');
      if (!child || child === 'node_modules') continue;
      const full = path.join(base, child, name);
      let st;
      try {
        st = fsApi.statSync(full); // 子项不是目录 / 文件不在：这一次 stat 抛，跳过
      } catch {
        continue;
      }
      if (!st?.isFile?.()) continue;
      found.push({ path: full, name: child, mtimeMs: Number(st.mtimeMs) || 0 });
    }
    return found;
  }
  const dir = String(rule.dir ?? '');
  if (!dir || dir.includes(`${path.sep}node_modules${path.sep}`)) return [];
  let names;
  try {
    names = fsApi.readdirSync(dir);
  } catch {
    return [];
  }
  const match = rule.match instanceof RegExp ? rule.match : null;
  const found = [];
  for (const rawName of Array.isArray(names) ? names : []) {
    const name = String(rawName ?? '');
    if (!name || name === 'node_modules') continue;
    if (match && !match.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fsApi.statSync(full);
    } catch {
      continue; // 目录里刚删掉的、断链的符号链接：跳过这一个，不影响整根
    }
    if (!st?.isFile?.()) continue;
    found.push({ path: full, name, mtimeMs: Number(st.mtimeMs) || 0 });
  }
  return found;
}

/**
 * 把一个类枚举成读建议数组（字符串）。
 * config 按路径字典序（确定、可复现），files 按 mtime 降序（最近动过的日志优先）。
 * 超过 READ_HINTS_MAX_ITEMS 条时截断，末尾补一句「还有 N 条」。
 *
 * @returns {string[]}
 */
function hintsOfKind(kind, roots, fsApi) {
  const rules = Array.isArray(roots?.[kind]) ? roots[kind] : [];
  const found = [];
  for (const rule of rules) {
    for (const one of listRoot(rule, fsApi)) found.push(one);
  }
  // 同一路径别列两遍（比如 settings.yaml 同时被一条 file 规则和目录规则扫到）
  const seen = new Set();
  const unique = found.filter((one) => {
    if (seen.has(one.path)) return false;
    seen.add(one.path);
    return true;
  });
  if (kind === 'files') {
    unique.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  } else {
    unique.sort((a, b) => a.path.localeCompare(b.path));
  }
  if (unique.length === 0) {
    return READ_HINT_EMPTY[kind] ? [READ_HINT_EMPTY[kind]] : [];
  }
  const kept = unique.slice(0, READ_HINTS_MAX_ITEMS).map((one) => one.path);
  const rest = unique.length - kept.length;
  if (rest > 0) kept.push(`还有 ${rest} 条`);
  return kept;
}

/** 九类对象全枚举一遍：config / files 扫盘，其余给固定读法。 */
export function enumerateReadHints({ roots = defaultReadRoots(), fs: fsApi = fs } = {}) {
  const table = {};
  for (const kind of OBJECT_KINDS) {
    if (kind.id === 'config' || kind.id === 'files') {
      table[kind.id] = hintsOfKind(kind.id, roots, fsApi);
    } else if (READ_HINT_TEXT[kind.id]) {
      table[kind.id] = [READ_HINT_TEXT[kind.id]];
    } else {
      table[kind.id] = [];
    }
  }
  return table;
}

/**
 * 60 秒 TTL 的整表缓存。一拍里只算一次（各层都拿同一份表），过期了才重扫。
 *
 * @param {{ttlMs?: number, now?: () => number}} [options]
 */
export function createReadHintCache({ ttlMs = READ_HINTS_TTL_MS, now = () => Date.now() } = {}) {
  let stamp = null;
  let table = {};
  let hits = 0;
  let misses = 0;
  return {
    ttlMs,
    /** 有缓存就回缓存，没有就调一次 loader（loader 返回整表）。 */
    all(loader) {
      const t = Number(now());
      if (stamp !== null && t - stamp >= 0 && t - stamp < ttlMs) {
        hits += 1;
        return table;
      }
      misses += 1;
      table = typeof loader === 'function' ? loader() : {};
      stamp = t;
      return table;
    },
    /** 丢掉缓存（改配置、换根、测试里用）。 */
    invalidate() {
      stamp = null;
      table = {};
    },
    get stats() {
      return { hits, misses };
    },
  };
}

/**
 * 配置覆盖的归一：`proposer.readHints` 是 `{ objectKind: [字符串, ...] }`。
 * 非法值（不认识的类、不是数组、元素不是字符串）忽略并打日志，绝不拒加载；
 * 空数组按「没配」处理，保留默认枚举——写成 `files: []` 大概不是想把这一栏清空。
 *
 * @param {unknown} override
 * @param {{log?: (line: string) => void}} [options]
 * @returns {Record<string, string[]>}
 */
export function normalizeReadHints(override, { log = () => {} } = {}) {
  const out = {};
  if (override === undefined || override === null) return out;
  if (typeof override !== 'object' || Array.isArray(override)) {
    log('readHints 不是对象（要 { objectKind: [路径, ...] }），整块忽略');
    return out;
  }
  for (const [rawKind, value] of Object.entries(override)) {
    const kind = normalizeReadHintKind(rawKind);
    if (!kind) {
      log(`readHints 里的「${rawKind}」不是对象类别，忽略`);
      continue;
    }
    if (!Array.isArray(value)) {
      log(`readHints.${rawKind} 不是字符串数组，忽略`);
      continue;
    }
    const list = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        log(`readHints.${rawKind} 里有非字符串项，忽略那一项`);
        continue;
      }
      const text = item.trim();
      if (text) list.push(text);
    }
    if (list.length === 0) {
      log(`readHints.${rawKind} 是空数组，按没配处理，保留默认读建议`);
      continue;
    }
    out[kind] = list;
  }
  return out;
}

/** 把覆盖叠到枚举结果上：配了的类整类替换，没配的保持枚举。 */
export function mergeReadHints(enumerated = {}, override = {}, { log } = {}) {
  const table = { ...enumerated };
  for (const [kind, list] of Object.entries(normalizeReadHints(override, { log }))) {
    table[kind] = list;
  }
  return table;
}

/**
 * 单类的读建议（带缓存）。给「只想问一类」的调用方用；一拍里要几类就优先用
 * buildAllReadHints，只算一次盘。
 *
 * @param {{kind?: string, roots?: object, cache?: object|null, fs?: object, override?: object, log?: (line: string) => void}} [input]
 * @returns {string[]}
 */
export function buildReadHints({ kind, roots, cache = null, fs: fsApi = fs, override, log } = {}) {
  const wanted = normalizeReadHintKind(kind);
  if (!wanted) return [];
  const table = cache
    ? cache.all(() => enumerateReadHints({ roots, fs: fsApi }))
    : enumerateReadHints({ roots, fs: fsApi });
  const merged = mergeReadHints(table, override, { log });
  return Array.isArray(merged[wanted]) ? merged[wanted] : [];
}

/**
 * 九类一次性拿全（config / files 扫盘，其余是固定读法），套上配置覆盖。
 * 返回的每个数组元素都是字符串，直接进候选行。
 *
 * @param {{roots?: object, cache?: object|null, fs?: object, override?: object, log?: (line: string) => void}} [input]
 * @returns {Record<string, string[]>}
 */
export function buildAllReadHints({ roots, cache = null, fs: fsApi = fs, override, log } = {}) {
  const table = cache
    ? cache.all(() => enumerateReadHints({ roots, fs: fsApi }))
    : enumerateReadHints({ roots, fs: fsApi });
  return mergeReadHints(table, override, { log });
}
