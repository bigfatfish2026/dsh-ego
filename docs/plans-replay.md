# 想法重放：改 gate 之前的回归

每版 stage2 方案都会落一行盘：gate 拒的、veto 拒的、`step1.verdict=abort` 的、空拍（`pick` 空串）、
被 judge/gate 打回重写的都写，判完的也写。以前方案正文只在日志里剩一句 `ga_hits` 摘要，改完 gate
想知道「刚才被误伤的那条 plan 现在过不过」，只能等下一拍随机产出类似想法——120~250 秒一次、还未必撞上。
现在旧 plan 就在盘上，原地重跑一遍就行。

## 文件

默认 `~/.dsh-ego/plans.jsonl`（配置项 `plansPath`，或环境变量 `DSH_EGO_PLANS_PATH`），一行一条 JSON、
append-only，跟 `state.json` / `veto.jsonl` 分开存。1.0.0 之前默认落在工作区同级
（`<工作区>/dsh-ego.plans.jsonl`），升级时要显式指一次老路径，否则重放看不到旧计划：

```sh
export DSH_EGO_PLANS_PATH=/home/<user>/fatfish/dsh-ego.plans.jsonl
```

## 一行是什么

`ts` / `callId` / `comboKey` / `candidate`（pick 编号 + 读与动作的原语×对象 + 动机 + 种子）/
`plan`（整份方案原文，不截断）/ `gate`（`ok`、`hits`、`items` 逐条 `{ga, action, why}`，
action 是 reject / downgrade / unsupported）/ `veto`（`{ok, hit, ran}`，没走到 veto 就写 `null`）/
`judge`（`{action, reason}`，没叫终审就写 `null`）/ `outcome` / `round`（第几轮重写，首轮 0）。
一行一份 plan，不合并。

脱敏：写之前整份记录按字符串值过一遍 `redactVetoText`（该函数里的密钥前缀表全覆盖，命中就换成
`***`），遮完仍是合法 JSON。

写失败不影响裁决：序列化、轮转、append 全包在 try/catch 里，磁盘满 / 权限错 / 路径不存在都只记一行
`plans_log_fail:…`，这一拍照旧往下判。append 用 `appendFileSync`（O_APPEND + 一次 write），
单行不与别的写者交错。

轮转：每次 append 前看一眼，文件超过 20MB 或超过 3000 行就改名成 `.1`（覆盖旧的 `.1`），新文件从空开始。
行数不每次全量数，按 `stat.size` 命中进程内缓存，对不上才重数。

## 拒因折成规则（lessons）

plans.jsonl 里的 `gate.items` / `veto.hit` / `judge.reason` 平时没人读。`lib/lessons.js` 每拍顺手
统计最近 14 天的拒因，按「GA 号 + 动作 + why 归一后的前 24 字」计数（veto 的 rule+reason、judge 的
reason 各单独一路），折成最多 5 条规则句写进 `~/.dsh-ego/lessons.json`：

- 写盘条件是「距上次 ≥24 小时」且「窗口内拒因 ≥20 条」，不满足就一个字节都不写；
- 同一条规则跨轮累加 `hits`、刷新 `lastSeen`；14 天没再命中的自动掉出，超过 5 条时留命中多、
  最近还命中的那几条；同一个原语最多占 2 条（`LESSON_PER_PRIMITIVE_MAX`，按 rule 前缀
  `<原语> 这类方案` 认，veto / judge 两路不占配额），免得一个原语把 5 条名额全吃掉；
- `buildStage2Prompt` 在候选表之后、combo 摘要之前拼一段「近期反复被拦的毛病」，整段 ≤520 字
  （`LESSON_PROMPT_MAX`：标题 32 + 5 条 ×（2 + 90 + 1）= 497，留 23 字余量）、一条 90 字
  （`LESSON_RULE_MAX`）、0 条不加；combo 摘要已经点名的 GA
  不再重复；
- 日志：`lessons: N 条｜新增 M｜<ms>ms`；缓存文件读坏时按空表跑，并多一行 `lessons_bad:N`。

## 跑回归

```sh
node scripts/replay.js                              # 最近 50 条
node scripts/replay.js --limit 200 --since 2026-01-01
node scripts/replay.js --ga GA10 --changed          # 只看历史命中过 GA10、且现在有变化的
node scripts/replay.js --arbiter --max-cases 8 --limit 5   # 连 arbiter 一起重放（会调模型、花钱）
```

`--arbiter` 会把 gate 判不了的灰色条目（`unsure`）打包交给 arbiter 逐条判，**这一步会真调模型、会产生费用，
所以默认关**；不开时只看 gate + veto，一分钱不花。`--arbiter-model <name>` 只换模型名（provider 沿用 headless
默认路由），`--max-cases N` 限一次送几条（默认 8，1–24，跟线上同一套截断规则）。开了之后汇总行后面多一行
`arbiter：送 X 条｜pass a｜reject b｜downgrade c｜失败 d`，逐条明细里追一句 `arbiter:GA10｜downgrade｜why:…`。
arbiter 判 reject 或 downgrade 都会让条目算「变差」（旧 gate 放行、新链路拒/打回），所以开了之后退出码 1
会更常见，这是预期。

输出先一行汇总，再逐条列：

```text
重放 2 条：变好 1｜没变 1｜变差 0
2026-01-01T13:20:00.000Z inspect|files→edit-file|files 变好：GA10 不再命中（旧：idea 里的数字 0.1、0 找不到出处）
2026-01-01T13:28:00.000Z inspect|config→edit-config|config 没变：ga_hits 没变
```

有「变差」时退出码 1（方便以后接 CI），否则 0；读不到落盘文件退出码 2。过滤口径：`--since` / `--limit`
按本地日算、`--limit` 取最近 N 条，`--ga` 只看那行历史上命中过这条 GA 的记录，`--changed` 只列前后有变化的。

## 代码里直接调

`replayPlan(record, { vetoEnabled, nowMs, arbiter, arbiterConfig })` 返回
`{ before, after, changed, notes, veto, pass, arbiter }`（`changed` = `better` / `same` / `worse`，
比较只认拒与降级，未核不算坏；`arbiter` 为 `null` 表示这次没跑，对象则是
`{ cases, sent, skipped, verdicts, failed }`）；`replayFile(path, { since, until, limit, ga, onlyChanged, arbiter })`
返回 `{ total, better, same, worse, items, arbiter }`。默认不调模型、不写任何文件、不动 state；
只有传了 `arbiter` 才真调模型。

## 变差率按改动规模分层接权重

combo 历史把大改和小修小补混在一个账本里，大改更容易被判变差，一路拒下来那一对就被压到
系数下限、永远抽不到。现在同一对的重放结果按改动规模分三档，权重只看它**最近一次**落盘方案
所在档的账（`lib/change-scale.js`）：

| 档 | 判据 | worse 率阈值 | 系数下限 |
| --- | --- | --- | --- |
| small | `files ≤ 1` 且 `writes ≤ 1` | < 35% 不降权 | 0.4 |
| medium | 其余 | < 35% 不降权 | 0.6 |
| large | `files ≥ 3`，或 `steps` 含 delete / service / outbound 任一 | < 50% 不降权 | 0.8 |

`files` 取 `plan.plan.files` 与 `step2.files` 去重合并；`writes` 取 `intent.impact` 的
paths + services + remotes 非空条数；`steps` 认 `P6×files` / `delete|files` / `delete×files`
三种写法。判定顺序是先 large 再 small，所以「3 个文件但只写 1 处」算 large。

系数：`worse 率 < 阈值` → 1；否则 `clamp(1 - worse 率, 该档下限, 1)`。
与 combo 系数合并是 `clamp(combo × scale, 0.3, 2.0)`（`COMBINED_FACTOR_MIN/MAX`，顺序固定
「先 combo 后 scale」），只乘在随机抽取的权重上，确定性排序路径不受影响。

成本：每拍开跑时用同一份 plans.jsonl 现算（`loadScaleHistory`，gate 只建一次，只重放
`lib/replay.js` 的 `judgeChange` 口径，不调模型、不写盘）。实测 283 行首次约 143ms
（其中 gate 重放 119ms），文件 mtime+size 没变时直接复用整表（0ms）。没有 `plan` 的
中间态记录（abort / empty）不进分母。

## 两个已知边界

GA3/GA4 要读盘那半默认不跑（不传 `deps` 就记 unsupported，别把「未核」当「合格」）；GA14 的
`outboundTargets` 白名单默认空表，要复核那一条就从代码里传 `outboundTargets`。
所以改 gate 的正确姿势是：先 `node scripts/replay.js --changed` 看旧 plan 有没有被新规则误伤，
再决定这次改动收不收。
