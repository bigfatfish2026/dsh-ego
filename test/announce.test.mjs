/**
 * 开机自报的单测：开/关、每进程只发一次、没有目标会话不发也不崩、兜底上限、
 * 文本是「版本号 + 一句醒来的短指令」而不是死模板、send 只被调一次（跟 ask 同一条通道）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNOUNCE_INSTRUCTION,
  DEFAULT_ANNOUNCE_DELAY_MS,
  DEFAULT_ANNOUNCE_TEMPLATE,
  announceWaitMs,
  buildAnnounceLog,
  buildAnnounceText,
  createAnnouncer,
} from '../lib/announce.js';

const FACTS = { version: '0.1.3' };

test('announceOnStart = false：一句都不发，只记日志', async () => {
  const lines = [];
  let sends = 0;
  const announcer = createAnnouncer({
    enabled: false,
    targetId: () => 'sess-abc',
    send: async () => {
      sends += 1;
      return { ok: true };
    },
    log: (line) => lines.push(line),
    facts: () => FACTS,
  });
  const result = await announcer.announce();
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(sends, 0, '关掉就一次都不能调 send');
  assert.ok(lines.some((l) => l.includes('announceOnStart = false')));
});

test('每进程只成功报一次：第二次直接跳过，send 调用次数还是 1', async () => {
  let sends = 0;
  const announcer = createAnnouncer({
    targetId: () => 'sess-abc',
    send: async () => {
      sends += 1;
      return { ok: true };
    },
    facts: () => FACTS,
  });
  const first = await announcer.announce();
  const second = await announcer.announce();
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.skipped, true);
  assert.equal(sends, 1, '同一条 send 通道只该被调一次');
  assert.equal(announcer.sent, true);
});

test('还没有目标会话：不发、不崩、记一行日志，之后学到了还能发', async () => {
  let target = '';
  let sends = 0;
  const lines = [];
  const announcer = createAnnouncer({
    targetId: () => target,
    send: async () => {
      sends += 1;
      return { ok: true };
    },
    log: (line) => lines.push(line),
    facts: () => FACTS,
  });
  const missed = await announcer.announce();
  assert.equal(missed.ok, false);
  assert.equal(missed.skipped, false, '没发出去不算「报过了」，要留给重试');
  assert.equal(sends, 0, '没目标会话不许碰 send');
  assert.ok(lines.some((l) => l.includes('还没有目标会话')));
  assert.equal(announcer.sent, false);

  target = 'sess-xyz'; // 用户在私聊里说了一句，学到了
  const later = await announcer.announce();
  assert.equal(later.ok, true, '学到目标会话后还能补报');
  assert.equal(sends, 1);
});

test('send 失败不置「已报」：下一轮还能再试', async () => {
  let sends = 0;
  const announcer = createAnnouncer({
    targetId: () => 'sess-abc',
    send: async () => {
      sends += 1;
      return sends === 1 ? { ok: false, detail: '会话正忙' } : { ok: true };
    },
    facts: () => FACTS,
  });
  assert.equal((await announcer.announce()).ok, false);
  assert.equal(announcer.sent, false);
  assert.equal((await announcer.announce()).ok, true);
  assert.equal(sends, 2);
});

test('send 说 pending（话已排进队列）：带 queued 标记，且不算「已报」', async () => {
  const lines = [];
  const announcer = createAnnouncer({
    targetId: () => 'sess-abc',
    send: async () => ({ ok: false, pending: true, detail: '会话不在活表' }),
    log: (line) => lines.push(line),
    facts: () => FACTS,
  });
  const result = await announcer.announce();
  assert.equal(result.ok, false);
  assert.equal(result.queued, true, '闸门要靠这个标记开补发盯梢');
  assert.equal(result.pending, true);
  assert.equal(result.text, buildAnnounceText(FACTS), '补发盯梢要靠 text 认队列里那条');
  assert.equal(announcer.sent, false, '没真发出去就不许置「已报」');
  assert.ok(lines.some((l) => l.includes('已排进待发队列')));
});

test('send 抛错也不崩，记日志', async () => {
  const lines = [];
  const announcer = createAnnouncer({
    targetId: () => 'sess-abc',
    send: async () => {
      throw new Error('followup 炸了');
    },
    log: (line) => lines.push(line),
    facts: () => FACTS,
  });
  const result = await announcer.announce();
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => l.includes('followup 炸了')));
});

test('文本是干净的事实 + 一句短指令，不把内部指令原样带出去', () => {
  const text = buildAnnounceText(FACTS);
  assert.match(text, /dsh-ego 0\.1\.3 刚重启完，先看有没有该验的事，有就去做，没有就跟用户打句招呼，短。/);
  // 2026-11-08 起不写「下一拍」：那是加载时算的旧值，排期一变就成了假话
  assert.ok(!text.includes('下一拍'), '自报里不许再写死下一拍时间');
  assert.ok(text.endsWith(ANNOUNCE_INSTRUCTION), '短指令只留一句，放在最后');
  assert.equal(ANNOUNCE_INSTRUCTION, '刚重启完，先看有没有该验的事，有就去做，没有就跟用户打句招呼，短。');
  // 旧的长指令不许再出现
  assert.ok(!text.includes('跟用户说一句上线的话'), '别把「跟用户说一句上线的话」带进消息');
  assert.ok(!text.includes('自然些'));
  assert.ok(!text.includes('别复述这句'));
  assert.ok(!text.includes('也别报版本号'));
  // 没有版本号也不能崩
  assert.equal(buildAnnounceText(), `dsh-ego ${ANNOUNCE_INSTRUCTION}`);
  // 就算调用方还把旧字段传进来，也不许再吐出来
  assert.ok(!buildAnnounceText({ version: '0.1.8', nextRun: '11-08 19:04' }).includes('下一拍'));
});

test('日志把「配置的模板」和「实际文本」分成两条', () => {
  const text = buildAnnounceText(FACTS);
  const lines = buildAnnounceLog(text);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `开机自报：给主会话的指令 = ${DEFAULT_ANNOUNCE_TEMPLATE}`);
  assert.ok(lines[0].includes('{version}'), '模板行要留占位符原文，排障时能看出配的是什么');
  assert.match(lines[1], /^开机自报：实际文本 = dsh-ego 0\.1\.3 刚重启完/);
  assert.ok(!lines[0].includes('实际文本'));
  assert.ok(!lines[1].includes('给主会话的指令'));
});

test('成功发出去时，日志里两行都在，且没有把旧指令混进去', async () => {
  const lines = [];
  const announcer = createAnnouncer({
    targetId: () => 'sess-abc',
    send: async () => ({ ok: true }),
    log: (line) => lines.push(line),
    facts: () => FACTS,
  });
  assert.equal((await announcer.announce()).ok, true);
  assert.ok(lines.some((l) => l.startsWith('开机自报：给主会话的指令 =')));
  assert.ok(lines.some((l) => l.startsWith('开机自报：实际文本 =')));
  assert.ok(!lines.some((l) => l.includes('跟用户说一句上线的话')));
});

test('不配模板就走默认：整句和版本号拼法跟以前一样', () => {
  assert.equal(DEFAULT_ANNOUNCE_TEMPLATE, `dsh-ego {version} ${ANNOUNCE_INSTRUCTION}`);
  assert.equal(buildAnnounceText(FACTS), buildAnnounceText(FACTS, DEFAULT_ANNOUNCE_TEMPLATE));
  assert.equal(buildAnnounceText(FACTS), `dsh-ego 0.1.3 ${ANNOUNCE_INSTRUCTION}`);
});

test('配了整句就整句生效：能只换人称，也能完全不提版本号', () => {
  const own = 'dsh-ego {version} 刚重启完，没有就跟主人打句招呼，短。';
  assert.equal(buildAnnounceText(FACTS, own), 'dsh-ego 0.1.3 刚重启完，没有就跟主人打句招呼，短。');
  const noVersion = '醒了，去看看有没有该验的事。';
  assert.equal(buildAnnounceText(FACTS, noVersion), noVersion, '模板里没有占位符就原样发');
  assert.equal(buildAnnounceText(FACTS, '  '), `dsh-ego 0.1.3 ${ANNOUNCE_INSTRUCTION}`, '空白模板退回默认，不许发空话');
  assert.equal(buildAnnounceText(FACTS, undefined), `dsh-ego 0.1.3 ${ANNOUNCE_INSTRUCTION}`);
});

test('占位符替换版本号：出现几次换几次，版本为空不留双空格', () => {
  assert.equal(buildAnnounceText({ version: '9.9.9' }, 'v{version} / {version}'), 'v9.9.9 / 9.9.9');
  assert.equal(buildAnnounceText({}, 'dsh-ego {version} 刚重启完'), 'dsh-ego 刚重启完');
  assert.equal(
    buildAnnounceText({ version: '1.0.0' }, 'dsh-ego {version} 刚重启完'),
    'dsh-ego 1.0.0 刚重启完',
  );
  assert.equal(buildAnnounceText(FACTS, '{version}'), '0.1.3');
  assert.equal(buildAnnounceText(FACTS, '{other}'), '{other}', '不认识的占位符原样留着，不静默吃掉');
});

test('自报器也认模板：配的整句真的从 send 出去，日志里是模板原文', async () => {
  const sent = [];
  const lines = [];
  const announcer = createAnnouncer({
    targetId: () => 'sess-abc',
    send: async (text) => {
      sent.push(text);
      return { ok: true };
    },
    log: (line) => lines.push(line),
    facts: () => FACTS,
    template: 'dsh-ego {version} 刚重启完，没有就跟主人打句招呼，短。',
  });
  assert.equal((await announcer.announce()).ok, true);
  assert.deepEqual(sent, ['dsh-ego 0.1.3 刚重启完，没有就跟主人打句招呼，短。']);
  assert.ok(lines.some((l) => l.includes('{version}')), '日志第一行留模板原文');
  assert.ok(lines.some((l) => l.includes('dsh-ego 0.1.3 刚重启完')), '日志第二行是实际文本');
});

test('兜底上限：默认 10 秒、不再抖动；非法值退回默认，0 表示立刻兜底', () => {
  assert.equal(DEFAULT_ANNOUNCE_DELAY_MS, 10_000);
  assert.equal(announceWaitMs(DEFAULT_ANNOUNCE_DELAY_MS), 10_000);
  assert.equal(announceWaitMs(30_000), 30_000, '可配');
  assert.equal(announceWaitMs(0), 0, '0 就是立刻走兜底');
  assert.equal(announceWaitMs(-1), 10_000, '负数退回默认');
  assert.equal(announceWaitMs('abc'), 10_000, '非数字退回默认');
  assert.equal(announceWaitMs(undefined), 10_000);
});
