/**
 * 入口小工具：日志时间格式、服务惰性探测、版本号、会话 id 派生、
 * 聊天前端偏好读取、会话作用域解析、相对路径双基准查找。
 *
 * 路径常量按本文件位置算；仓库/工作区根可用 DSH_EGO_REPO_ROOT 覆盖，
 * 默认取插件目录的上两级（适配 plugins/<name> 这种布局）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isKnownScope } from './scope.js';
import { checkExists, checkFileLine } from './exists.js';

const fmt = (t) => {
  if (!t) return '—';
  const d = new Date(Number(t));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 从 ctx 上摸一个服务：events / schedule 都是惰性探测，不写进 inject。
 * 硬 inject 缺服务会让整个插件不 apply——ego 的意念、pending、开机自报全跟着停，
 * 就为了等一个 tick 来源，不值。探测失败返回 undefined，降级路径自己兜。
 */
function probed(ctx, name) {
  const getter = ctx.get;
  if (typeof getter !== 'function') return undefined;
  try {
    const found = getter.call(ctx, name);
    return found === undefined || found === null ? undefined : found;
  } catch {
    return undefined;
  }
}

/** 自报里带的版本号，读不到就空着（不因为读不到版本就发不出去） */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg?.version ?? '');
  } catch {
    return '';
  }
}

/** 没轮换过的会话 id 是 sha256(sessionKey) 的前 32 位（跟宿主的派生规则一致） */
function derivedSessionId(key) {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/* ── 聊天前端的偏好：优先走服务接口，拿不到再读文件 ──────────────────
 * 路径、格式、并发写语义都归聊天前端管，这里不再自己解析。
 * 宿主没装这个服务、或它还没就绪时打一次 warning，退回读 qqPrefsPath。
 * 服务名是配置项 `prefsService`，默认按宿主约定；换了前端就改配置（或者只用文件）。
 */
function probePrefsService(ctx, serviceName) {
  if (!ctx || !serviceName) return undefined;
  let raw;
  try {
    raw = ctx.get?.(serviceName);
  } catch {
    raw = undefined;
  }
  if (raw === undefined || raw === null) {
    try {
      raw = ctx[serviceName];
    } catch {
      raw = undefined;
    }
  }
  return raw && typeof raw.payload === 'function' ? raw : undefined;
}

function fallbackReadPrefs(prefsPath) {
  try {
    return JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  } catch {
    return {};
  }
}

function makePrefsReader(ctx, prefsPath, logger, serviceName) {
  let warned = false;
  return function readPrefs() {
    const service = probePrefsService(ctx, serviceName);
    if (service) {
      try {
        const payload = service.payload();
        if (payload && typeof payload === 'object') return payload;
      } catch (error) {
        if (!warned) {
          warned = true;
          logger.warn?.(`dsh-ego: ${serviceName}.payload() 读失败，回退读文件：${String(error?.message ?? error)}`);
        }
      }
    } else if (!warned) {
      warned = true;
      logger.warn?.(`dsh-ego: 没有 ${serviceName} 服务，回退直接读 ${prefsPath}`);
    }
    return fallbackReadPrefs(prefsPath);
  };
}

/**
 * 会话 → 群聊/私聊。只学私聊（privateOnly），所以这张表只回答「这个会话是不是私聊」。
 * 查不到就当不知道，宁可不学。
 */
function makeScopeResolver(readPrefs) {
  let cache = { at: 0, map: new Map() };
  return function scopeOf(sessionId) {
    if (!sessionId) return undefined;
    if (Date.now() - cache.at > 60_000) {
      const map = new Map();
      try {
        const data = readPrefs();
        const keys = new Set([
          ...Object.keys(data.sessionIds ?? {}),
          ...Object.keys(data.overrides ?? {}),
          ...Object.keys(data.presets ?? {}),
        ]);
        for (const key of keys) {
          const scope = String(key).split(':')[2];
          if (!isKnownScope(scope)) continue;
          const rotated = data.sessionIds?.[key];
          if (rotated) map.set(String(rotated), scope);
          map.set(derivedSessionId(key), scope);
        }
      } catch {
        /* 读不到偏好文件：当作不知道 */
      }
      cache = { at: Date.now(), map };
    }
    return cache.map.get(sessionId);
  };
}

/** 本文件所在目录 = 插件根；工作区根默认取上两级，可用 DSH_EGO_REPO_ROOT 覆盖 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.DSH_EGO_REPO_ROOT || path.resolve(PLUGIN_DIR, '..', '..');

/** 相对路径两种基准都试：插件目录查不到再按仓库根查（绝对路径不受 cwd 影响，查一次就够） */
async function checkExistsFrom(primaryCwd, fallbackCwd, object) {
  const first = await checkExists(object, { cwd: primaryCwd });
  if (first?.status !== 'missing') return first;
  return checkExists(object, { cwd: fallbackCwd });
}

/**
 * 同上：`lib/gate.js:36` 与 `plugins/dsh-ego/lib/gate.js:36` 两种写法都认。
 * 只有「文件没找到」才换基准重试：行号越界也是 missing，但那时 totalLines 有值，
 * 换 cwd 也救不回来，重试只会把「行号 9999 超过总行数」盖成「路径不存在」。
 */
async function checkFileLineFrom(primaryCwd, fallbackCwd, anchor) {
  const first = await checkFileLine(anchor, { cwd: primaryCwd });
  if (first?.status === 'ok' || first?.totalLines != null) return first;
  return checkFileLine(anchor, { cwd: fallbackCwd });
}


export {
  fmt,
  probed,
  readVersion,
  makePrefsReader,
  makeScopeResolver,
  checkExistsFrom,
  checkFileLineFrom,
  PLUGIN_DIR,
  REPO_ROOT,
};
