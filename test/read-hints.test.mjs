/**
 * 读建议：候选行末尾那一栏的路径，由 ego 运行时枚举真实文件，
 * 不维护静态表。
 *
 * 盯五件事：
 *   1. 枚举：只在已知的几个根上扫一层；存在的 cordis.patch.yml / settings.yaml / *.log 列出来，
 *      不存在的根跳过，不抛；
 *   2. 排序与截断：files 按 mtime 取最近 5 个，config 按路径字典序，超出标「还有 N 条」；
 *   3. 缓存：60 秒内二次调用不重复读盘，过期才重扫；
 *   4. 配置覆盖：proposer.readHints 给了就整类替换，非法值忽略并打日志；
 *   5. 渲染：候选行只留 `读建议：#C0N` 指针，路径挪到提示词末尾
 *      「可读位置（按候选编号）」区块单列——单候选 300 字 / 5 条封顶，整段 1200 字封顶，
 *      超了按候选顺序截并写省略提示；候选行自己仍封顶 200 字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  READ_HINTS_MAX_ITEMS,
  READ_HINT_TEXT,
  buildAllReadHints,
  buildReadHints,
  createReadHintCache,
  defaultReadRoots,
  enumerateReadHints,
  normalizeReadHints,
} from '../lib/read-hints.js';
import { buildGrid } from '../lib/grid.js';
import {
  CANDIDATE_LINE_MAX_CHARS,
  READ_HINT_LINE_MAX_CHARS,
  READ_HINT_LINE_MAX_ITEMS,
  READ_HINTS_SECTION_MAX_CHARS,
  READ_HINTS_SECTION_TITLE,
  buildProposerPrompt,
  buildReadHintsSection,
  buildStage2Prompt,
  renderCandidateLine,
  renderReadHintLine,
} from '../lib/proposer.js';

/** 假 fs：`dirs` 是「目录 → 条目名」，`files` 是「路径 → mtimeMs」。只实现 readdirSync / statSync。 */
function fakeFs({ dirs = {}, files = {} } = {}) {
  const stats = { readdir: 0, stat: 0 };
  const namesOf = new Map(Object.entries(dirs).map(([dir, names]) => [dir, names.map(String)]));
  const mtimes = new Map(Object.entries(files).map(([file, mtime]) => [file, Number(mtime) || 0]));
  return {
    stats,
    fs: {
      readdirSync(dir) {
        stats.readdir += 1;
        if (!namesOf.has(dir)) {
          const err = new Error(`ENOENT: ${dir}`);
          err.code = 'ENOENT';
          throw err;
        }
        return [...namesOf.get(dir)];
      },
      statSync(target) {
        stats.stat += 1;
        if (namesOf.has(target)) return { isFile: () => false, mtimeMs: 0 };
        if (mtimes.has(target)) return { isFile: () => true, mtimeMs: mtimes.get(target) };
        for (const [dir, names] of namesOf) {
          if (names.some((name) => path.join(dir, name) === target)) {
            return { isFile: () => true, mtimeMs: mtimes.get(target) ?? 0 };
          }
        }
        const err = new Error(`ENOENT: ${target}`);
        err.code = 'ENOENT';
        throw err;
      },
    },
  };
}

/** 一套只存在于假 fs 里的根：两个目录都在，第三个不存在。 */
function fakeRoots() {
  return {
    config: [
      { base: '/dsh/profiles', name: 'cordis.patch.yml' },
      { base: '/fatfish/plugins', name: 'cordis.patch.yml' },
      { base: '/not/here', name: 'cordis.patch.yml' },
      { file: '/dsh/settings.yaml' },
    ],
    files: [{ dir: '/fatfish/logs', match: /\.log$/ }],
  };
}

const CONFIG_TREE = {
  dirs: {
    '/dsh/profiles': ['alpha', 'beta', 'notes.txt'],
    '/fatfish/plugins': ['dsh-ego', 'dsh-qq'],
  },
  files: {
    '/dsh/profiles/alpha/cordis.patch.yml': 1000,
    '/dsh/profiles/beta/cordis.patch.yml': 2000,
    '/fatfish/plugins/dsh-ego/cordis.patch.yml': 3000,
    '/fatfish/plugins/dsh-qq/cordis.patch.yml': 4000,
    '/dsh/settings.yaml': 5000,
    '/dsh/profiles/notes.txt': 6000,
  },
};

test('枚举 config：两个根里存在的 cordis.patch.yml + settings.yaml 都列出来，不存在的根跳过', () => {
  const { fs: fsApi } = fakeFs(CONFIG_TREE);
  const hints = buildReadHints({ kind: 'config', roots: fakeRoots(), fs: fsApi });
  assert.deepEqual(hints, [
    '/dsh/profiles/alpha/cordis.patch.yml',
    '/dsh/profiles/beta/cordis.patch.yml',
    '/dsh/settings.yaml',
    '/fatfish/plugins/dsh-ego/cordis.patch.yml',
    '/fatfish/plugins/dsh-qq/cordis.patch.yml',
  ]);
  // .txt 不匹配、目录 /not/here 读不到：一个都不许混进来
  assert.ok(!hints.some((one) => one.endsWith('notes.txt')));
});

test('根全不存在：不抛，返回兜底一句（不是空数组）', () => {
  const { fs: fsApi } = fakeFs({});
  const roots = { config: [{ base: '/nowhere', name: 'cordis.patch.yml' }] };
  const hints = buildReadHints({ kind: 'config', roots, fs: fsApi });
  assert.equal(hints.length, 1);
  assert.match(hints[0], /没扫到/);
});

test('枚举不递归、不碰 node_modules：子目录里只 stat 那一个固定文件名', () => {
  const { fs: fsApi, stats } = fakeFs({
    dirs: { '/dsh/profiles': ['a', 'node_modules'] },
    files: { '/dsh/profiles/a/cordis.patch.yml': 1 },
  });
  const hints = buildReadHints({
    kind: 'config',
    roots: { config: [{ base: '/dsh/profiles', name: 'cordis.patch.yml' }] },
    fs: fsApi,
  });
  assert.deepEqual(hints, ['/dsh/profiles/a/cordis.patch.yml']);
  assert.equal(stats.readdir, 1, '只 readdir 一次 base，不递归');
  assert.ok(!JSON.stringify(stats).includes('node_modules'));
});

test('枚举 files：按 mtime 取最近 5 个，超出标「还有 N 条」', () => {
  const dir = '/fatfish/logs';
  const names = ['a.log', 'b.log', 'c.log', 'd.log', 'e.log', 'f.log', 'g.log', 'run.sh'];
  const files = { [`${dir}/run.sh`]: 1 };
  names.forEach((name, i) => {
    if (name.endsWith('.log')) files[path.join(dir, name)] = 100 + i;
  });
  const { fs: fsApi } = fakeFs({ dirs: { [dir]: names }, files });
  const hints = buildReadHints({ kind: 'files', roots: { files: [{ dir, match: /\.log$/ }] }, fs: fsApi });
  assert.equal(hints.length, READ_HINTS_MAX_ITEMS + 1, '5 条路径 + 一条「还有 N 条」');
  assert.deepEqual(hints.slice(0, 5), ['g.log', 'f.log', 'e.log', 'd.log', 'c.log'].map((name) => path.join(dir, name)));
  assert.equal(hints.at(-1), '还有 2 条');
});

test('不给路径的几类给读法：service / memory / ticket / session / external-doc / external-repo', () => {
  const { fs: fsApi } = fakeFs({});
  const table = enumerateReadHints({ roots: {}, fs: fsApi });
  for (const kind of ['service', 'memory', 'ticket', 'session', 'external-doc', 'external-repo']) {
    assert.deepEqual(table[kind], [READ_HINT_TEXT[kind]], `${kind} 应给固定读法`);
  }
  assert.match(table.service[0], /host_status/);
  assert.match(table['external-doc'][0], /web_search/);
  assert.match(table['external-repo'][0], /git -C/);
});

test('缓存：60 秒内二次调用不重复读盘，过期才重扫', () => {
  const { fs: fsApi, stats } = fakeFs(CONFIG_TREE);
  let clock = 1_000_000;
  const cache = createReadHintCache({ ttlMs: 60_000, now: () => clock });
  const roots = fakeRoots();
  const first = buildAllReadHints({ roots, cache, fs: fsApi });
  const readsAfterFirst = stats.readdir + stats.stat;
  assert.ok(readsAfterFirst > 0, '第一次必须真读盘');

  clock += 59_000;
  const second = buildAllReadHints({ roots, cache, fs: fsApi });
  assert.equal(stats.readdir + stats.stat, readsAfterFirst, '60 秒内不许再读盘');
  assert.deepEqual(second, first, '缓存命中回同一份表');

  clock += 2_000; // 61 秒
  buildAllReadHints({ roots, cache, fs: fsApi });
  assert.ok(stats.readdir + stats.stat > readsAfterFirst, '过期后要重扫');
  assert.equal(cache.stats.misses, 2);
  assert.equal(cache.stats.hits, 1);

  cache.invalidate();
  buildAllReadHints({ roots, cache, fs: fsApi });
  assert.equal(cache.stats.misses, 3, 'invalidate 之后重算');
});

test('配置覆盖：配了的类整类替换，没配的照旧枚举；非法值忽略并打日志', () => {
  const { fs: fsApi } = fakeFs(CONFIG_TREE);
  const logs = [];
  const table = buildAllReadHints({
    roots: fakeRoots(),
    fs: fsApi,
    override: {
      files: ['/tmp/only.log', '  /tmp/second.log  '],
      bogus: ['x'],
      config: 'not-an-array',
      service: [],
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(table.files, ['/tmp/only.log', '/tmp/second.log'], 'files 整类替换且去空白');
  assert.ok(table.config.length > 0 && table.config[0].startsWith('/dsh/'), 'config 没配，保持枚举');
  assert.deepEqual(table.service, [READ_HINT_TEXT.service], '空数组按没配处理');
  assert.equal(logs.length, 3, '不认识/不是数组/空数组各留一行日志');
  assert.ok(logs.some((line) => line.includes('bogus')));
  assert.ok(logs.some((line) => line.includes('config')));
});

test('normalizeReadHints：externalDoc 别名认成 external-doc，非对象整块忽略', () => {
  assert.deepEqual(normalizeReadHints({ externalDoc: ['/repo'] }), { 'external-doc': ['/repo'] });
  assert.deepEqual(normalizeReadHints({ files: [1, '', 'ok'] }), { files: ['ok'] });
  const logs = [];
  assert.deepEqual(normalizeReadHints(['x'], { log: (line) => logs.push(line) }), {});
  assert.equal(logs.length, 1);
  assert.deepEqual(normalizeReadHints(undefined), {});
});

test('defaultReadRoots：只扫固定的几处，路径里没有 node_modules', () => {
  const roots = defaultReadRoots({ home: '/home/tester' });
  assert.deepEqual(roots.config.map((one) => one.base ?? one.file), [
    '/home/tester/.dsh/profiles',
    '/home/tester/fatfish/plugins',
    '/home/tester/.dsh/settings.yaml',
  ]);
  assert.deepEqual(roots.config.slice(0, 2).map((one) => one.name), ['cordis.patch.yml', 'cordis.patch.yml']);
  assert.deepEqual(roots.files.map((one) => one.dir), ['/home/tester/fatfish/logs']);
  assert.ok(!JSON.stringify(roots).includes('node_modules'));
});

test('grid 候选带 readHints：按读格的对象类取表', () => {
  const rows = buildGrid({
    materials: [{ text: '翻日志找报错', motivation: 'hygiene' }],
    primitives: { inspect: true, editFile: true },
    objects: { files: true, config: true },
    readHints: { files: ['/fatfish/logs/a.log'], config: ['/dsh/settings.yaml'] },
    now: Date.now(),
  });
  assert.ok(rows.length > 0);
  for (const row of rows) assert.ok(Array.isArray(row.readHints), '每行都要有这一栏（可空）');
  assert.deepEqual(rows[0].readHints, ['/fatfish/logs/a.log'], '第一行读的是 files，取 files 那一栏');
});

test('候选行只留指针：「读建议：#C01」，路径不进候选行', () => {
  const line = renderCandidateLine({
    id: 'C01',
    read: { primitive: 'inspect', objectKind: 'config' },
    action: { primitive: 'edit-config', objectKind: 'config' },
    note: '读 读 × 配置 → 动 改配置 × 配置｜种子：yaml 里有没有没人用的项',
    readHints: ['/dsh/settings.yaml', '/dsh/profiles/a/cordis.patch.yml'],
  });
  assert.match(line, /读建议：#C01$/);
  assert.equal(line.includes('/dsh/settings.yaml'), false, '候选行不再塞具体路径');
  assert.equal(line.includes('/dsh/profiles/a/cordis.patch.yml'), false, '一条路径都不许留在候选行');

  const none = renderCandidateLine({ id: 'C02', read: { primitive: 'inspect', objectKind: 'files' } });
  assert.match(none, /读建议：#C02$/, '没读建议也一样只留指针');

  // 路径再长也撑不大候选行：那 200 字预算只留给 head + note
  const long = renderCandidateLine({
    id: 'C01',
    read: { primitive: 'inspect', objectKind: 'files' },
    action: { primitive: 'edit-file', objectKind: 'files' },
    note: '种子：翻日志',
    readHints: [`/${'x'.repeat(300)}.log`],
  });
  assert.match(long, /读建议：#C01$/);
  assert.ok(Array.from(long).length < CANDIDATE_LINE_MAX_CHARS, '没有路径就不该顶到 200 字上限');
});

test('候选行封顶 200 字：note 太长就按码点截断并标 …', () => {
  const line = renderCandidateLine({
    id: 'C01',
    read: { primitive: 'inspect', objectKind: 'files' },
    action: { primitive: 'edit-file', objectKind: 'files' },
    note: `种子：${'很长的说明'.repeat(60)}`,
  });
  const chars = Array.from(line);
  assert.equal(chars.length, CANDIDATE_LINE_MAX_CHARS);
  assert.equal(chars.at(-1), '…');

  const short = renderCandidateLine({ id: 'C01', read: { primitive: 'inspect', objectKind: 'files' } });
  assert.ok(Array.from(short).length < CANDIDATE_LINE_MAX_CHARS);
});

/* ── 提示词末尾「可读位置（按候选编号）」区块 ───────── */

/** 造一个候选：读格 / 动作格固定 config，note 短，readHints 可给。 */
function cand(id, readHints = [], note = '种子：yaml 里有没有没人用的项') {
  return {
    id,
    read: { primitive: 'inspect', objectKind: 'config' },
    action: { primitive: 'edit-config', objectKind: 'config' },
    note,
    readHints,
  };
}

test('end：区块标题 + 每候选一行，编号跟候选行的指针对得上', () => {
  const list = [
    cand('C01', ['/dsh/settings.yaml', '/dsh/profiles/a/cordis.patch.yml']),
    cand('C02', ['/fatfish/logs/ego.log']),
    cand('C03', []),
  ];
  const prompt = buildStage2Prompt(list, []);
  const titleAt = prompt.indexOf(READ_HINTS_SECTION_TITLE);
  assert.ok(titleAt > 0, '提示词里要有「可读位置（按候选编号）」区块');
  assert.equal((prompt.match(/可读位置（按候选编号）/g) ?? []).length, 1, '只出现一次');

  const section = prompt.slice(titleAt);
  const lines = section.split('\n').filter((one) => /^#C0\d 读建议：/.test(one));
  assert.equal(lines.length, 3, '每个候选一行');
  assert.equal(lines[0], '#C01 读建议：/dsh/settings.yaml；/dsh/profiles/a/cordis.patch.yml');
  assert.equal(lines[1], '#C02 读建议：/fatfish/logs/ego.log');
  assert.match(lines[2], /^#C03 读建议：（这一格没有具体路径/, '没路径的候选也要有一行，别让指针悬空');

  // 区块在提示词末尾：在候选表与 JSON schema 之后
  assert.ok(titleAt > prompt.indexOf('"pick"'), '区块要在末尾，不在候选表里');
  assert.equal(prompt.indexOf(READ_HINTS_SECTION_TITLE) > prompt.indexOf('候选表（这一拍代码已经挑好一对'), true);
});

test('单候选超过 5 条：列 5 条，末尾写「…等 N 条」（N 是这一格总条数）', () => {
  assert.equal(READ_HINT_LINE_MAX_ITEMS, READ_HINTS_MAX_ITEMS, '区块的 5 条上限跟枚举那处同值，别各写一个数');
  const hints = [1, 2, 3, 4, 5, 6, 7].map((i) => `/srv/app/logs/service-${i}.log`);
  const line = renderReadHintLine({ id: 'C01', readHints: hints });
  assert.match(line, /…等 7 条$/);
  const body = line.slice(0, line.indexOf('…'));
  assert.equal(body.split('；').length, 5, '最多列 5 条');
  assert.ok(body.startsWith('#C01 读建议：/srv/app/logs/service-1.log'));
  for (const one of body.split('；')) {
    assert.match(one.replace(/^#C01 读建议：/, ''), /^\/srv\/app\/logs\/service-\d\.log$/, '每条都是完整路径');
  }

  // 枚举那边（lib/read-hints.js）末尾那一条「还有 N 条」是计数，不占 5 条名额
  const withMarker = [...hints.slice(0, 5), '还有 2 条'];
  assert.match(renderReadHintLine({ id: 'C02', readHints: withMarker }), /…等 7 条$/);
});

test('单候选一行封顶 300 字：超了在条目边界截，路径不切半截', () => {
  const hints = [1, 2, 3, 4, 5].map((i) => `/srv/app/plugins/${'p'.repeat(80)}-${i}/cordis.patch.yml`);
  const line = renderReadHintLine({ id: 'C01', readHints: hints });
  assert.ok(Array.from(line).length <= READ_HINT_LINE_MAX_CHARS);
  assert.match(line, /…等 5 条$/, '截了就标总条数');
  const listed = line.slice(0, line.indexOf('…')).split('；').map((one) => one.replace(/^#C01 读建议：/, ''));
  assert.ok(listed.length >= 1 && listed.length < hints.length, '放不下全部，但至少一条');
  for (const one of listed) {
    assert.ok(hints.includes(one), `列出来的必须是完整原路径，实际：${one}`);
  }
});

test('整段超 1200 字：按候选顺序截断，末尾写「（后 N 条候选的读建议已省略）」', () => {
  const longPath = (i) => `/srv/app/plugins/${'q'.repeat(240)}/cordis-${i}.patch.yml`;
  const list = Array.from({ length: 10 }, (_, i) => cand(`C${String(i + 1).padStart(2, '0')}`, [longPath(i)]));
  const section = buildReadHintsSection(list);
  assert.ok(Array.from(section).length <= READ_HINTS_SECTION_MAX_CHARS, '整段封顶 1200 字');
  const match = /（后 (\d+) 条候选的读建议已省略）$/.exec(section);
  assert.ok(match, '超了要写省略提示');
  const omitted = Number(match[1]);
  const kept = section.split('\n').filter((one) => /^#C0\d 读建议：/.test(one));
  assert.ok(kept.length > 0, '至少留一条');
  assert.equal(kept.length + omitted, list.length, '留下的 + 省略的 = 全部候选');
  // 按候选顺序截：留下的编号从 C01 起连续，省略的是尾巴上那几条
  kept.forEach((line, i) => assert.ok(line.startsWith(`#C${String(i + 1).padStart(2, '0')} `), `第 ${i + 1} 行应是 C0${i + 1}`));

  // 没超的时候不写省略提示
  assert.equal(buildReadHintsSection([cand('C01', ['/dsh/settings.yaml'])]).includes('已省略'), false);
});

test('stage1 提示词不含这一块：只挑候选，不读文件（源码断言）', () => {
  const prompt = buildProposerPrompt({ materials: [{ text: '翻日志找报错', motivation: 'hygiene' }] });
  assert.equal(prompt.includes(READ_HINTS_SECTION_TITLE), false, 'stage1 提示词里不许出现这个区块');
  assert.equal(prompt.includes('可读位置'), false);

  const source = fs.readFileSync(new URL('../lib/proposer.js', import.meta.url), 'utf8');
  const stage1Start = source.indexOf('export function buildProposerPrompt');
  const stage1End = source.indexOf('/* ══ 两阶段');
  assert.ok(stage1Start > 0 && stage1End > stage1Start, '源码里要能切出 stage1 提示词函数');
  const stage1Body = source.slice(stage1Start, stage1End);
  assert.equal(stage1Body.includes('buildReadHintsSection'), false, 'stage1 不许拼读建议区块');
  assert.equal(stage1Body.includes('可读位置'), false);
  // 区块只在一处拼：一处定义 + 一处调用（buildStage2Prompt 里）
  assert.equal((source.match(/buildReadHintsSection\(/g) ?? []).length, 2);
});

test('源码断言：提示词那句指向「读建议」栏，不再说「按格子直接读」', () => {
  const source = fs.readFileSync(new URL('../lib/proposer.js', import.meta.url), 'utf8');
  assert.ok(source.includes('候选行末尾的「读建议」就是该踩的实例'), '源码里要有指向读建议栏的那句');
  assert.ok(!source.includes('候选给了读格子（read.primitive / read.objectKind）就按格子直接读那几处'),
    '老口径（只按格子读）不该留着');
});
