/**
 * 时段与整点排期的单测（纯函数，不联网、不碰 dsh）
 *   node --test test/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { delayMs, hit, inQuiet, isPeak, nextHourTick, nextWindow, rollDice, speakingWindow } from '../lib/window.js';

const at = (y, m, d, h, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s, 0);
const cfg = { quietStart: 23.66, quietEnd: 8, offPeakOnly: true, holidays: [] };

test('nextHourTick：严格取下一个整点，跨零点也认', () => {
  assert.equal(nextHourTick(at(2026, 11, 8, 14, 50)).getTime(), at(2026, 11, 8, 15, 0).getTime());
  assert.equal(nextHourTick(at(2026, 11, 8, 14, 0, 0)).getTime(), at(2026, 11, 8, 15, 0).getTime(), '整点本身要跳到下一个');
  assert.equal(nextHourTick(at(2026, 11, 8, 23, 30)).getTime(), at(2026, 11, 9, 0, 0).getTime(), '跨日');
  assert.equal(nextHourTick(at(2026, 12, 31, 23, 59, 59)).getTime(), at(2027, 1, 1, 0, 0).getTime(), '跨年');
});

test('delayMs：整点距离 + 0~delayMaxMinutes 随机，落在区间内', () => {
  const now = at(2026, 11, 8, 14, 50);
  const toHour = 10 * 60 * 1000;
  const max = 8 * 60 * 1000;
  assert.equal(delayMs(now, { delayMaxMinutes: 8 }, () => 0), toHour);
  assert.equal(delayMs(now, { delayMaxMinutes: 8 }, () => 1), toHour + max);
  assert.equal(delayMs(now, { delayMaxMinutes: 8 }, () => 0.5), toHour + max / 2);
  for (let i = 0; i < 200; i += 1) {
    const ms = delayMs(now, { delayMaxMinutes: 8 });
    assert.ok(ms >= toHour && ms <= toHour + max, `越界：${ms}`);
  }
  assert.equal(delayMs(now, {}, () => 1), toHour, '没配 delayMaxMinutes 就只落在整点');
  assert.equal(delayMs(now, { delayMaxMinutes: 0 }, () => 1), toHour, '0 就是整点那一刻');
});

test('峰价时段：工作日 9-12、14-18 才贵', () => {
  assert.equal(isPeak(at(2026, 11, 9, 10)), true, '周一 10 点');
  assert.equal(isPeak(at(2026, 11, 9, 11, 59)), true);
  assert.equal(isPeak(at(2026, 11, 9, 12)), false, '午休谷价');
  assert.equal(isPeak(at(2026, 11, 9, 15)), true);
  assert.equal(isPeak(at(2026, 11, 9, 18)), false);
  assert.equal(isPeak(at(2026, 11, 8, 10)), false, '周日全天谷价');
  assert.equal(isPeak(at(2026, 11, 9, 10), ['2026-11-09']), false, '节假日算谷价');
});

test('安静时段支持小数小时：23.66 = 23:40', () => {
  assert.equal(inQuiet(at(2026, 11, 8, 23, 39), 23.66, 8), false, '23:39 还没到');
  assert.equal(inQuiet(at(2026, 11, 8, 23, 40), 23.66, 8), true, '23:40 起算');
  assert.equal(inQuiet(at(2026, 11, 8, 23, 59), 23.66, 8), true);
  assert.equal(inQuiet(at(2026, 11, 9, 0, 30), 23.66, 8), true, '跨午夜');
  assert.equal(inQuiet(at(2026, 11, 9, 7, 59), 23.66, 8), true);
  assert.equal(inQuiet(at(2026, 11, 9, 8, 0), 23.66, 8), false, '8 点整解除');
  assert.equal(inQuiet(at(2026, 11, 8, 3), 0, 0), false, '起止相同 = 不启用');
  assert.equal(inQuiet(at(2026, 11, 8, 23, 30), 23, 8), true, '老配置写整数照样认');
});

test('能不能跑：峰价不跑，安静时段不跑', () => {
  assert.equal(speakingWindow(at(2026, 11, 9, 10), cfg).ok, false, '周一 10 点峰价');
  assert.equal(speakingWindow(at(2026, 11, 9, 20), cfg).ok, true, '周一 20 点谷价');
  assert.equal(speakingWindow(at(2026, 11, 8, 23, 45), cfg).ok, false, '23:45 安静');
  assert.equal(speakingWindow(at(2026, 11, 8, 23, 10), cfg).ok, true, '23:10 还没到安静');
  assert.equal(speakingWindow(at(2026, 11, 8, 13), cfg).ok, true, '周日午间');
});

test('下一个能跑的窗口', () => {
  const next = nextWindow(at(2026, 11, 8, 23, 50), cfg);
  assert.equal(next.getHours(), 8, '深夜 → 次日 8 点');
  assert.equal(next.getDate(), 9);
});

test('骰子：掷到命中线以下才算中', () => {
  assert.equal(rollDice(() => 0.5), 50);
  assert.equal(hit(29.9, 35), true);
  assert.equal(hit(35, 35), false);
  assert.equal(hit(0, 0), false);
});
