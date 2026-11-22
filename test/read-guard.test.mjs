/**
 * 只读 helper 的敏感路径守卫（lib/read-guard.js）。
 *
 * B 方案（helper 标 origin=subagent）之后 read/glob/grep 才真的能用，
 * 这里钉住「凭据类路径读不进提示词」：read 直读、grep/glob 点名或整根搜索都要拦，
 * 普通代码/配置路径照旧放行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SENSITIVE_BASENAME_PATTERNS,
  installReadGuard,
  readGuardDecision,
  sensitiveBasename,
} from '../lib/read-guard.js';

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-read-guard-'));
  const home = path.join(dir, 'home');
  const files = [
    '.dsh/.env',
    '.dsh/.env.secrets',
    '.dsh/providers.json',
    '.dsh/profiles/qqbot/cordis.patch.yml',
    '.ssh/id_rsa',
    '.dsh-ego/state.json',
    'fatfish/plans/backlog-bl-x-1234.md',
    'repo/.env',
    'repo/src/gate.js',
  ];
  for (const one of files) {
    const file = path.join(home, one);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x\n');
  }
  return { dir, home };
}

const call = (name, args) => ({ name, arguments: args });

test('凭据类文件名黑名单：至少覆盖 .env / .env.secrets / .credentials.yaml / id_rsa', () => {
  for (const name of ['.env', '.ENV', '.env.local', '.env.secrets', '.credentials.yaml', '.credentials.yml']) {
    assert.notEqual(sensitiveBasename(name), '', `${name} 必须被认出来`);
  }
  for (const name of ['providers.json', 'auth.json', 'id_rsa', 'id_ed25519', 'server.key', 'cert.pem', '.npmrc']) {
    assert.notEqual(sensitiveBasename(name), '', `${name} 必须被认出来`);
  }
  assert.equal(sensitiveBasename('cordis.patch.yml'), '');
  assert.equal(sensitiveBasename('gate.js'), '');
  assert.ok(SENSITIVE_BASENAME_PATTERNS.length >= 8);
});

test('read：凭据文件与受保护目录直接拒，普通配置/代码放行', () => {
  const { dir, home } = makeHome();
  try {
    const opts = { home, cwd: home };
    for (const rel of ['.dsh/.env', '.dsh/.env.secrets', '.dsh/providers.json', '.ssh/id_rsa']) {
      const why = readGuardDecision(call('read', { file_path: path.join(home, rel) }), opts);
      assert.ok(why, `${rel} 必须被拦`);
      assert.match(why, /凭据类路径/);
    }
    assert.match(
      readGuardDecision(call('read', { file_path: '~/.dsh/.env' }), opts),
      /凭据类路径/,
      '~ 展开后也要拦',
    );
    assert.equal(
      readGuardDecision(call('read', { file_path: path.join(home, '.dsh/profiles/qqbot/cordis.patch.yml') }), opts),
      undefined,
      'profiles 下的配置是在读证据，不能拦',
    );
    assert.equal(readGuardDecision(call('read', { file_path: path.join(home, 'repo/src/gate.js') }), opts), undefined);
    assert.equal(
      readGuardDecision(call('read', { file_path: path.join(home, '.dsh-ego/state.json') }), opts),
      undefined,
      'ego 自己的状态/日志不拦（自指方向要查）',
    );
    assert.equal(readGuardDecision(call('read_image', { file_path: path.join(home, 'repo/src/gate.js') }), opts), undefined, '非凭据图片路径不拦');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('grep/glob：点名凭据文件名、搜 home 或 ~/.dsh 整根、根下一层有 .env 都拒', () => {
  const { dir, home } = makeHome();
  try {
    const opts = { home, cwd: home };
    // pattern / include 点名
    assert.match(readGuardDecision(call('grep', { pattern: 'KEY', include: '*.env' }), opts), /凭据类路径/);
    assert.match(readGuardDecision(call('glob', { pattern: '**/.env' }), opts), /凭据类路径/);
    assert.match(readGuardDecision(call('glob', { pattern: '**/id_rsa' }), opts), /凭据类路径/);

    // 搜索根：home / ~/.dsh / ~/.ssh；以及没写 path 时默认 cwd=home
    for (const root of [home, path.join(home, '.dsh'), path.join(home, '.ssh')]) {
      const why = readGuardDecision(call('grep', { pattern: 'foo', path: root }), opts);
      assert.ok(why, `${root} 必须被拦`);
    }
    assert.ok(readGuardDecision(call('glob', { pattern: '*.js' }), opts), '不写 path 默认搜 home，也要拦');

    // 根下一层就摆着 .env 的仓库：整仓 grep 也会带出凭据
    assert.match(readGuardDecision(call('grep', { pattern: 'foo', path: path.join(home, 'repo') }), opts), /.env/);

    // 正常取证路径放行
    assert.equal(readGuardDecision(call('grep', { pattern: 'cheapWindows', path: path.join(home, '.dsh/profiles/qqbot') }), opts), undefined);
    assert.equal(readGuardDecision(call('glob', { pattern: '**/*.md', path: path.join(home, 'fatfish/plans') }), opts), undefined);
    assert.equal(readGuardDecision(call('read', { file_path: path.join(home, 'fatfish/plans/backlog-bl-x-1234.md') }), opts), undefined, '仓库外正常路径不拦');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('守卫只挂在 helper 的 tools 上：没有 guard 的老宿主静默跳过，别的工具不拦', () => {
  assert.equal(installReadGuard({ tools: {} }), undefined, '老宿主没 guard 也不抛');
  const guards = [];
  installReadGuard({ tools: { guard: (fn) => guards.push(fn) } }, { kind: 'stage2', home: '/home/none' });
  assert.equal(guards.length, 1);
  assert.equal(guards[0](call('memory_recall', { query: '.env' })), undefined);
  assert.match(guards[0](call('read', { file_path: '/home/none/.dsh/.env' })), /凭据类路径/);
});
