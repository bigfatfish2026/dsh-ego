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
    const own = 'dsh-ego {version} 刚重启完，没有就跟用户打句招呼，短。';
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

/*
 * GA14 的接线：配置项 `outboundTargets` 一路走到 gate。
 * apply 里那一行是 createGate({ outboundTargets: normalizeOutboundTargets(cfg.outboundTargets) })，
 * 这里用真 schema 解出来的 cfg 跑同一条链路——配了白名单就放行、空表就全拒。
 */
test('outboundTargets 接线：schema 默认空表，配上的白名单真的到达 gate（GA14）', async () => {
  const depsRoot = hostDepsRoot();
  assert.ok(depsRoot, '找不到宿主的 @deepseek-ai/schemastery 与 dsh-tools；设 DSH_EGO_HOST_DEPS 指向宿主的 node_modules');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-outbound-'));
  try {
    const mod = await import(stageEntry(depsRoot, tmp));
    const { createGate, normalizeOutboundTargets } = await import(
      pathToFileURL(path.join(tmp, 'lib', 'gate.js')).href
    );

    assert.deepEqual(mod.Config({}).outboundTargets, [], '不配就是空表（= 一律不许发）');
    const configured = mod.Config({ outboundTargets: ['c2c:abc123', 'group:987654'] });
    assert.deepEqual(configured.outboundTargets, ['c2c:abc123', 'group:987654'], '配了原样保留');
    assert.throws(() => mod.Config({ outboundTargets: 'c2c:abc123' }), /expected array/, '写成字符串在入口就拒');
    assert.throws(() => mod.Config({ outboundTargets: [1] }), /expected string/, '元素不是字符串在入口就拒');

    // apply 里就是这一句，表达式的形状也钉住（改接线时这条会先红）
    // DEFAULTS 搬到 lib/config.js（schema 默认值同处），源码断言两份一起读
    const source = [
      fs.readFileSync(path.join(tmp, 'lib', 'index.js'), 'utf8'),
      fs.readFileSync(path.join(tmp, 'lib', 'config.js'), 'utf8'),
    ].join('\n');
    assert.ok(
      source.includes('outboundTargets: normalizeOutboundTargets(cfg.outboundTargets)'),
      'apply 要把 cfg.outboundTargets 归一后传给 createGate',
    );
    assert.ok(/outboundTargets: \[\],/.test(source), 'DEFAULTS 要有 outboundTargets: []（旧配置漏这一栏时兜底）');

    const outboundCandidate = {
      id: 'C07',
      read: { primitive: 'inspect', primitiveKey: 'inspect', objectKind: 'session', objectKey: 'session' },
      action: { primitive: 'outbound', primitiveKey: 'outbound', objectKind: 'session', objectKey: 'session' },
      material: '给用户发一句备份盘满了',
      defaults: { impact: 'outbound', reversibility: 'none' },
    };
    const outboundPlan = (target) => ({
      pick: 'C07',
      idea: '备份盘 36 小时没清，给用户发一句',
      why: '盘子快满，先打个招呼',
      object: { kind: 'session', value: target, anchor: `${target}@2026-11-10T05:28:00Z` },
      evidence: [{ claim: '备份盘用了 92%', source: 'host_status', value: '36', at: '2026-11-10T05:28:00Z' }],
      plan: { steps: ['P7×session'], files: [], estLines: 0 },
      intent: {
        impact: { paths: [], services: [], remotes: [] },
        reversibility: 'none',
        dryRun: { ok: true, detail: 'chat_recall 该会话' },
        undo: { kind: '', ref: '', howto: 'chat 补发一句更正，已发的那条收不回' },
      },
    });
    const check = (cfg) => createGate({ outboundTargets: normalizeOutboundTargets(cfg.outboundTargets) })
      .checkPlan(outboundPlan('c2c:abc123'), { candidates: [outboundCandidate] });

    const allowed = await check(configured);
    assert.equal(allowed.ok, true, allowed.reject.map((one) => one.why).join('；'));
    assert.equal(allowed.hits.includes('GA14'), false);

    const blank = await check(mod.Config({}));
    assert.equal(blank.ok, false);
    assert.deepEqual(blank.reject.map((one) => one.ga), ['GA14']);
    assert.match(blank.reject[0].why, /outbound 目标不在白名单里/);

    // 旧配置漏这一栏（cfg 上 undefined）：归一回空表，不把 undefined 漏进 gate
    const legacy = await check({ outboundTargets: undefined });
    assert.deepEqual(legacy.reject.map((one) => one.ga), ['GA14']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/*
 * 读建议的接线：schema 认 proposer.readHints 这一栏，
 * 非法值不拒加载（z.any，交给 apply 里的 normalizeReadHints 剔掉并打日志），
 * 而且这一栏真的进了 buildGrid（候选行才有东西可渲染）。
 */
test('readHints 接线：schema 认这一栏、非法值不拒加载、候选真的带上枚举结果', async () => {
  const depsRoot = hostDepsRoot();
  assert.ok(depsRoot, '找不到宿主依赖；设 DSH_EGO_HOST_DEPS 指向宿主的 node_modules');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ego-readhints-'));
  try {
    const mod = await import(stageEntry(depsRoot, tmp));
    assert.deepEqual(mod.Config({}).proposer.readHints, {}, '不配就是空表，走运行时枚举');
    const configured = mod.Config({ proposer: { readHints: { files: ['/tmp/a.log'], externalDoc: ['/repo'] } } });
    assert.deepEqual(configured.proposer.readHints, { files: ['/tmp/a.log'], externalDoc: ['/repo'] },
      '配了原样保留（别名归一在 read-hints.js 里做）');
    // z.any：写成字符串也不拒加载，只是会被 normalizeReadHints 整块忽略并写日志
    assert.equal(mod.Config({ proposer: { readHints: 'nope' } }).proposer.readHints, 'nope');

    // 提议段已搬到 lib/engines/proposer.js：读取源加上提议器
    const source = [
      fs.readFileSync(path.join(tmp, 'lib', 'index.js'), 'utf8'),
      fs.readFileSync(path.join(tmp, 'lib', 'engines', 'proposer.js'), 'utf8'),
    ].join('\n');
    assert.ok(source.includes('buildAllReadHints({'), 'apply/propose 里要真调枚举');
    assert.ok(source.includes('readHints: hintTable'), '枚举结果要传给 buildGrid');
    assert.ok(source.includes('normalizeReadHints(cfg.proposer.readHints'), '配置覆盖要先归一');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
