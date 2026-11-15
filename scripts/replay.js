#!/usr/bin/env node
/**
 * 想法重放 CLI：把落盘的 stage2 方案按当前 gate 重跑一遍，看改动是变好还是变坏。
 *
 *   node scripts/replay.js
 *   node scripts/replay.js --limit 100 --since 2026-11-10
 *   node scripts/replay.js --ga GA10 --changed
 *   node scripts/replay.js --arbiter --max-cases 8 --limit 5
 *
 * 默认只跑 gate + veto（纯代码、不花钱）；加 --arbiter 才把 gate 判不了的灰色条目
 * 交给 arbiter 逐条判，这一步会真调模型、会产生费用，所以默认关。
 * 退出码：有「变差」返回 1（以后接 CI），否则 0；读不到文件返回 2。
 * 重放不写任何文件、不动 state——只读 plans.jsonl（落盘那行已经脱敏过）。
 */
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARBITER_TIMEOUT_MS, clampArbiterMaxCases } from '../lib/arbiter.js';
import { replayFile } from '../lib/replay.js';
import { DEFAULT_PLANS_PATH } from '../lib/plans-log.js';
import { clipLogText } from '../lib/text.js';

/** 默认落盘文件跟 lib/plans-log.js 的 DEFAULT_PLANS_PATH 一致 */
const DEFAULT_FILE = DEFAULT_PLANS_PATH;

const LABELS = { better: '变好', same: '没变', worse: '变差' };

function usage() {
  return [
    '用法：node scripts/replay.js [--file 路径] [--limit N] [--since YYYY-MM-DD] [--ga GA10] [--changed]',
    '       [--arbiter [--arbiter-model 模型名] [--max-cases N]]',
    `默认：--file ${DEFAULT_FILE} --limit 50`,
    '--arbiter 会真调模型、产生费用，默认关；--max-cases 默认 8（1–24）。',
    '--arbiter-model 只换模型名，provider 用 headless 默认路由那个。',
  ].join('\n');
}

/** 认 `--k v` 与 `--k=v` 两种写法；未知参数直接报错，别静默忽略 */
export function parseArgs(argv = []) {
  const out = {
    file: DEFAULT_FILE,
    limit: 50,
    since: null,
    ga: '',
    changed: false,
    arbiter: false,
    arbiterModel: '',
    maxCases: 0,
  };
  const known = new Set(['file', 'limit', 'since', 'ga', 'changed', 'arbiter', 'arbiter-model', 'max-cases']);
  /** 命令行写法 → 返回字段名（带连字符的键在 JS 里不好用） */
  const fieldOf = { 'arbiter-model': 'arbiterModel', 'max-cases': 'maxCases' };
  const flags = new Set(['changed', 'arbiter']);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] ?? '');
    if (!raw.startsWith('--')) {
      const error = new Error(`认不出的参数：${raw}\n${usage()}`);
      error.code = 'EARGS';
      throw error;
    }
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    const key = eq >= 0 ? body.slice(0, eq) : body;
    if (!known.has(key)) {
      const error = new Error(`认不出的参数：--${key}\n${usage()}`);
      error.code = 'EARGS';
      throw error;
    }
    if (flags.has(key)) {
      if (eq >= 0) {
        const error = new Error(`--${key} 不带值`);
        error.code = 'EARGS';
        throw error;
      }
      out[key] = true;
      continue;
    }
    const value = eq >= 0 ? body.slice(eq + 1) : String(argv[i + 1] ?? '');
    if (eq < 0) i += 1;
    if (!value) {
      const error = new Error(`--${key} 缺值\n${usage()}`);
      error.code = 'EARGS';
      throw error;
    }
    out[fieldOf[key] ?? key] = value;
  }
  const limit = Number(out.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    const error = new Error(`--limit 要是正整数，收到 ${JSON.stringify(out.limit)}`);
    error.code = 'EARGS';
    throw error;
  }
  out.limit = Math.floor(limit);
  if (out.maxCases !== 0) {
    const maxCases = Number(out.maxCases);
    if (!Number.isFinite(maxCases) || maxCases <= 0) {
      const error = new Error(`--max-cases 要是正整数，收到 ${JSON.stringify(out.maxCases)}`);
      error.code = 'EARGS';
      throw error;
    }
    // 跟 arbiter.js 的 selectArbiterCases 同一套截断规则（1–24，越界夹边界）
    out.maxCases = clampArbiterMaxCases(maxCases);
  }
  if (out.arbiterModel && !out.arbiter) {
    const error = new Error('--arbiter-model 要跟 --arbiter 一起用');
    error.code = 'EARGS';
    throw error;
  }
  out.file = path.resolve(out.file);
  return out;
}

function formatTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '（没记时间）';
  return new Date(n).toISOString();
}

/** 一条 arbiter 判定：`arbiter:GA10｜downgrade｜why:…`（why 跟 ga_hit 同口径 240 字封顶） */
export function formatArbiterJudge(judgment) {
  const ga = String(judgment?.ga ?? '').trim().toUpperCase() || 'GA?';
  const decision = String(judgment?.decision ?? '').trim().toLowerCase() || 'unknown';
  const why = clipLogText(String(judgment?.why ?? '').trim(), 240) || '（没写原因）';
  return `arbiter:${ga}｜${decision}｜why:${why}`;
}

/** 汇总那行：`arbiter：送 X 条｜pass a｜reject b｜downgrade c｜失败 d` */
export function formatArbiterSummary(arbiter) {
  return `arbiter：送 ${Number(arbiter?.sent) || 0} 条`
    + `｜pass ${Number(arbiter?.pass) || 0}`
    + `｜reject ${Number(arbiter?.reject) || 0}`
    + `｜downgrade ${Number(arbiter?.downgrade) || 0}`
    + `｜失败 ${Number(arbiter?.failed) || 0}`;
}

/** 一行汇总 + 逐条明细；明细格式固定，CI 里能直接 grep */
export function formatReport(result) {
  const lines = [
    `重放 ${result.total} 条：变好 ${result.better}｜没变 ${result.same}｜变差 ${result.worse}`,
  ];
  if (result.arbiter) lines.push(formatArbiterSummary(result.arbiter));
  for (const item of result.items) {
    const label = LABELS[item.changed] ?? item.changed;
    const parts = [];
    const notes = Array.isArray(item.notes) && item.notes.length > 0 ? item.notes.join('；') : 'ga_hits 没变';
    parts.push(notes);
    for (const judgment of Array.isArray(item.arbiter?.verdicts) ? item.arbiter.verdicts : []) {
      parts.push(formatArbiterJudge(judgment));
    }
    lines.push(`${formatTs(item.ts)} ${item.comboKey || '（无 comboKey）'} ${label}：${parts.join('；')}`);
  }
  return lines;
}

/** 从 `dsh --dump-config` 里抠 headless 默认路由的 provider（只换模型时得把它带上） */
export function defaultProviderFromDump(text) {
  let inBlock = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^-\s+id:\s*agent-default-model\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^-\s+id:/.test(line)) break;
    if (!inBlock) continue;
    const found = /^\s+provider:\s*(.+?)\s*$/.exec(line);
    if (found) return found[1].replace(/^['"]|['"]$/g, '').trim();
  }
  return '';
}

/** 读一次默认路由的 provider：只换 model 的 patch 是整段替换，缺 provider 会起不来 */
function readDefaultProvider(command, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, ['--profile', 'headless', '--dump-config'], { timeout: Math.min(timeoutMs, 60_000) }, (error, stdout) => {
      if (error) {
        resolve({ provider: '', error: String(error?.message ?? error) });
        return;
      }
      const provider = defaultProviderFromDump(stdout);
      resolve({ provider, error: provider ? '' : '配置里没有 agent-default-model.provider' });
    });
  });
}

/**
 * 真调模型的那只 arbiter 客户端：起一个 `dsh --profile headless` 子进程，提示词走 argv，
 * 最终回复从 stdout 取。`--arbiter-model` 用一次性 patch 覆盖默认模型（走 `/dev/stdin`，
 * 不落任何临时文件）；patch 是整段替换 config，所以 provider 要从默认配置里读出来一起带上。
 * 超时/退出码非 0/空回复都归一成 `{ok:false,error}`，由 runArbiter 降级。
 *
 * @param {{model?: string, timeoutMs?: number, command?: string}} [options]
 * @returns {(prompt: string) => Promise<{ok: boolean, text?: string, error?: string}>}
 */
export function createHeadlessArbiter({ model = '', timeoutMs = ARBITER_TIMEOUT_MS, command = 'dsh' } = {}) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : ARBITER_TIMEOUT_MS;
  // 命令名会拼进 bash -c（覆盖模型那条路），只认简单路径，别让参数变成 shell
  if (!/^[\w./-]+$/.test(String(command))) {
    return async () => ({ ok: false, error: `调用失败：命令名不合法（${String(command)}）` });
  }
  // 每次重放只读一次默认路由；没给 --arbiter-model 就不用读
  let routePromise = null;
  const routeOf = () => {
    if (!model) return Promise.resolve({ provider: '', error: '' });
    if (!routePromise) routePromise = readDefaultProvider(command, limit);
    return routePromise;
  };

  return async (prompt) => {
    const route = await routeOf();
    if (model && route.error) {
      return { ok: false, error: `调用失败：${route.error}` };
    }
    const patch = model
      // JSON 字符串是合法 YAML 标量，模型名里带冒号/井号也不用自己转义
      ? [
          '- id: agent-default-model',
          '  config:',
          `    provider: ${JSON.stringify(String(route.provider))}`,
          `    model: ${JSON.stringify(String(model))}`,
        ].join('\n') + '\n'
      : '';
    /*
     * 没 patch 就直接起 dsh；要覆盖模型时得让 dsh 从 `/dev/stdin` 读 overlay。
     * node 的 child stdin 是 socketpair，dsh 打开 /dev/stdin 会 ENXIO，所以套一层 bash
     * 用 `cat | dsh --patch /dev/stdin "$1"`：pipe 才是能重开的 fd，提示词仍走 argv。
     * 这样不落任何临时文件。
     */
    const args = patch
      ? ['-c', `cat | ${command} --profile headless --patch /dev/stdin "$1"`, 'dsh-arbiter', String(prompt ?? '')]
      : ['--profile', 'headless', String(prompt ?? '')];
    const bin = patch ? '/bin/bash' : command;

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, error: `调用失败：${String(error?.message ?? error)}` });
        return;
      }

      let out = '';
      let err = '';
      let done = false;
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };

      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出了 */
        }
        finish({ ok: false, error: `超时（${Math.round(limit / 1000)} 秒）` });
      }, limit);
      if (typeof timer?.unref === 'function') timer.unref();

      child.on('error', (error) => finish({ ok: false, error: `调用失败：${String(error?.message ?? error)}` }));
      child.stdout.on('data', (chunk) => {
        out += chunk;
        // 一段判定回复不可能这么大；超了说明跑歪了，掐掉按失败算
        if (out.length > 200_000) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已经退出了 */
          }
          finish({ ok: false, error: '空回复' });
        }
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('close', (code) => {
        const text = out.trim();
        if (code !== 0) {
          const tail = err.trim().split('\n').slice(-2).join(' ').slice(0, 200);
          finish({ ok: false, error: `调用失败（exit ${code}）：${tail || '没有 stderr'}` });
          return;
        }
        if (!text) {
          finish({ ok: false, error: '空回复' });
          return;
        }
        finish({ ok: true, text });
      });
      child.stdin.end(patch);
    });
  };
}

async function main(argv, deps = {}) {
  const write = typeof deps.write === 'function' ? deps.write : (line) => console.log(line);
  const runReplay = typeof deps.replayFile === 'function' ? deps.replayFile : replayFile;
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(String(error?.message ?? error));
    return 2;
  }
  const timeoutMs = ARBITER_TIMEOUT_MS;
  let arbiter = null;
  if (args.arbiter) {
    arbiter = typeof deps.arbiter === 'function'
      ? deps.arbiter
      : createHeadlessArbiter({ model: args.arbiterModel, timeoutMs });
    console.error('[replay] arbiter 模式：会真调模型、会产生费用（每条有灰色条目的记录一次）');
  }
  let result;
  try {
    result = await runReplay(args.file, {
      limit: args.limit,
      since: args.since,
      ga: args.ga,
      onlyChanged: args.changed,
      ...(arbiter ? { arbiter, arbiterConfig: { maxCases: args.maxCases || undefined, timeoutMs } } : {}),
    });
  } catch (error) {
    console.error(`[replay] ${String(error?.message ?? error)}`);
    return 2;
  }
  for (const line of formatReport(result)) write(line);
  if (result.skipped > 0) console.error(`[replay] 跳过 ${result.skipped} 行（认不出的 JSON / ts / 重放异常）`);
  // 开了 arbiter 之后 reject/downgrade 会让更多条目变 worse，退出码 1 是预期
  return result.worse > 0 ? 1 : 0;
}

export { main };

// 被 import 时（单测）不跑 main
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
