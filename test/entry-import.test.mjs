/**
 * 入口级防回归：真的 import 一次编译产物 lib/index.js。
 *
 * 0.1.6 的教训：102 条单测全绿，宿主里却 `failed to import: TypeError:
 * z.union(...).optional is not a function`——单测只 import 了 window/route 这些
 * 子模块，没人 import 入口，入口顶层的 Section() 一跑就崩也没人知道。
 *
 * 单测环境没装依赖，所以这里借宿主的 node_modules（schemastery / dsh-tools）
 * 在临时目录里复刻一次真实装载：拷一份 lib/ 过去，把宿主的 @scope 目录链过去。
 * 依赖从 dsh 可执行文件反查；换机器或换 nvm 版本不用改测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const libDir = fileURLToPath(new URL('../lib', import.meta.url));

/** 宿主的 node_modules：优先环境变量，其次顺着 PATH 里的 dsh 反查。 */
function hostDepsRoot() {
  const roots = [];
  if (process.env.DSH_EGO_HOST_DEPS) roots.push(process.env.DSH_EGO_HOST_DEPS);
  try {
    const dshBin = execSync('command -v dsh', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (dshBin) {
      // .../@deepseek-ai/dsh/lib/bin.js -> .../@deepseek-ai/dsh/node_modules
      const real = fs.realpathSync(dshBin);
      roots.push(path.join(path.dirname(path.dirname(real)), 'node_modules'));
    }
  } catch {
    // 没有 dsh 就只看环境变量
  }
  return roots.find(
    (root) =>
      fs.existsSync(path.join(root, '@deepseek-ai/schemastery')) &&
      fs.existsSync(path.join(root, '@deepseek-ai/dsh-tools')),
  );
}

/** 把 lib/ 拷进临时目录，链上宿主的 @scope 依赖，返回入口文件 URL。 */
function stageEntry(depsRoot, tmp) {
  const modules = path.join(tmp, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  for (const entry of fs.readdirSync(depsRoot)) {
    if (!entry.startsWith('@')) continue;
    fs.symlinkSync(path.join(depsRoot, entry), path.join(modules, entry), 'dir');
  }
  fs.cpSync(libDir, path.join(tmp, 'lib'), { recursive: true });
  return pathToFileURL(path.join(tmp, 'lib', 'index.js')).href;
}

test('编译产物 lib/index.js 能被真实 import，插件结构正常（0.1.6 入口崩溃防回归）', async () => {
  const depsRoot = hostDepsRoot();
  assert.ok(
    depsRoot,
    '找不到宿主的 @deepseek-ai/schemastery 与 dsh-tools；设 DSH_EGO_HOST_DEPS 指向宿主的 node_modules',
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-entry-'));
  try {
    // 拷一份必须和发布的一致：先断言源文件没被临时改花
    assert.ok(fs.existsSync(path.join(libDir, 'index.js')), 'lib/index.js 得存在（编译产物要提交）');

    const mod = await import(stageEntry(depsRoot, tmp));

    assert.equal(mod.name, 'dsh-ego', '导出 name 不对');
    assert.deepEqual(mod.inject, ['agents', 'tools'], 'inject 不对');
    assert.equal(typeof mod.Config, 'function', 'Config 要是 schemastery schema');
    assert.equal(typeof mod.apply, 'function', 'apply 要是函数');

    const config = mod.Config({});
    assert.equal(config.proposer.reasoningEffort, undefined, '不填 effort 时不该有默认值');
    assert.equal(config.judge.reasoningEffort, undefined);
    assert.equal(mod.Config({ proposer: { reasoningEffort: 'high' } }).proposer.reasoningEffort, 'high');
    assert.throws(
      () => mod.Config({ proposer: { reasoningEffort: 'medium' } }),
      /expected "low" \| "high" \| "max"/,
      'schema 要在入口就挡掉 medium，别等宿主请求时才炸',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('announceTemplate 的 schema：默认值、自定义整句生效、非法值在入口就拒', async () => {
  const depsRoot = hostDepsRoot();
  assert.ok(depsRoot, '找不到宿主依赖；设 DSH_EGO_HOST_DEPS 指向宿主的 node_modules');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-announce-'));
  try {
    const mod = await import(stageEntry(depsRoot, tmp));
    const { DEFAULT_ANNOUNCE_TEMPLATE } = await import(
      pathToFileURL(path.join(tmp, 'lib', 'announce.js')).href
    );
    assert.equal(
      mod.Config({}).announceTemplate,
      DEFAULT_ANNOUNCE_TEMPLATE,
      '不配就走默认整句',
    );
    const own = 'dsh-ego {version} 刚重启完，没有就跟主人打句招呼，短。';
    assert.equal(mod.Config({ announceTemplate: own }).announceTemplate, own, '整句可换，不只是换人称');
    // schemastery 先跑 pattern 再跑长度：空串报的是 pattern 那条
    assert.throws(() => mod.Config({ announceTemplate: '' }), /length >= 1|match regexp/, '空串拒');
    assert.throws(() => mod.Config({ announceTemplate: '   ' }), /match regexp/, '纯空白拒');
    assert.throws(() => mod.Config({ announceTemplate: 'x'.repeat(501) }), /length <= 500/, '超长拒');
    assert.throws(() => mod.Config({ announceTemplate: 1 }), /expected string/, '非字符串拒');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
