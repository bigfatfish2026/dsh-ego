# Changelog

## Unreleased

### Added

- **Scale-aware replay weights.** `lib/change-scale.js` buckets each pair's replayed plans
  by change size — small (`files ≤1` and `writes ≤1`), medium, large (`files ≥3` or a step
  touching delete / service / outbound) — and only the bucket of the pair's most recent plan
  feeds the weight: down-weight when the same-bucket worse rate reaches 35% (small/medium) or
  50% (large), with floors 0.4 / 0.6 / 0.8. `lib/replay.js` exports the pure `judgeChange`
  comparison and `loadScaleHistory` (mtime+size cached; 283 rows ≈143 ms cold, 0 ms warm).
  Grid multiplies combo × scale and clamps the result to 0.3–2.0; the deterministic sort path
  is unchanged.
- **Lessons: fold recurring rejections into the stage2 prompt.** `lib/lessons.js` counts the
  rejection reasons already stored in `plans.jsonl` (gate reject/downgrade, veto hits, judge
  reasons) over a 14-day window, folds them into at most 5 rule sentences kept in
  `~/.dsh-ego/lessons.json` (pruned after 14 days without a hit), and `buildStage2Prompt`
  carries them as a ≤400-char block after the candidate table, before the combo digest.
  Recomputation runs at most once per 24 hours and only when the window gained ≥20
  rejections; the log line is `lessons: N 条｜新增 M｜<ms>ms`.
- **GA21 justify gate + combo-history routing (stage2).** A stage2 plan now has to answer
  three questions — `justify.gain` / `surface` / `fallback`; missing, vague (under 8 chars
  or pure filler), unanchored (`gain` with no number and no object/file/evidence), or
  self-contradicting answers downgrade with `GA21` / code `GA21` and fall back to `silent`
  after rewrites. Separately, `lib/combo-history.js` summarises `plans.jsonl` per `comboKey`
  (win/loss, last 3 rejection reasons); grid multiplies the random pick weight by
  `clamp((win+1)/(loss+1), 0.4, 1.5)` and the stage2 prompt carries a ≤300-char digest.
  `justifyRequired` only governs the missing-field case, so replaying old records is unchanged.
- 夜间汇总多一段「另有 … 撞到每夜上限」：被 `nightMaxDo` / `nightMaxAsk` 拦下的条目
  以前只写一行日志就消失，早上那条汇总里一个字都没有（11-24 夜丢了 3 张 do，汇总
  只说「还有 2 张」）。现在跳过的每一条都记进当夜账本（`do-skipped` / `ask-skipped`）
  并进汇总。
- `lib/night.js` 导出 `findNightTicketByContent` / `trimJournal`：前者按 goal+brief 在
  夜间队列里找同一条活，后者统一「超上限丢最旧并报数」。

### Fixed

- 同一份活在夜间队列里重复入队：`ticketCallId` 只查白天队列与 `ticketRequests`，
  查不到就发新序号，于是夜里重判一次就在 `nightTicket` 里排成两条、各吃一张每夜额度，
  早上还连着推两遍。现在先查夜间队列并沿用原 callId，重复时记 `night_do_duplicate`。
- 重复入队不再错加 `nightDoCount`、不再在账本里记一笔并不存在的新 do。
- 夜间队列 / `state.nightTickets` 台账 / `state.nightJournal` 满 50（账本 200）条挤掉
  最旧时留一行 `night_ledger_trim`，以前是静默 `shift()`。

### Changed

- `createRoundEngine` 新增可选依赖 `openNightStore`：夜间 ask 落池用的存储层可注入。
  以前单测不注入，`nightAsk` 走真库 `~/.dsh/backlog/backlog.db`，跑一轮测试就往主人的
  工单池里塞一条假「[夜] 不限的一条」（bl-mwvg2ujd-f42c）。现在 `test/night.test.mjs`
  统一注入内存假存储，线上不传、行为不变。
- `nightMaxDo` / `nightMaxAsk` 的**插件默认值**从 0 改成 2，与 2026-11-23 起现网 profile
  的口径对齐（之前只有 profile 是 2，插件自带默认与注释放着「0 = 不限」，读代码的人会看错）。

- 第八档动机 `solution`「取已定方案并落地」：每拍只读 `~/.dsh/backlog/backlog.db` 取
  `status=已定方案` 的条目，stage2 只挑其中一条、只做方案的第一步（改文件 / 改配置），
  开票 goal 按「执行已定方案 <bl-id>：…；只做第一步：…；完成后把该条目改已完成」拼。
  池空时这条素材整条不进候选，不会拿空池硬出方案。
- gate 新增 GA18（来源可核）/ GA19（执行面收敛）/ GA20（单步），只对 solution 动机生效；
  三道都进 `REWRITE_GATE_ACTIONS` 落 `ask`，命中先打回重写、改不好再问人。
- 配置项 `backlogPath`（默认 `~/.dsh/backlog/backlog.db`，只读，读不到按空池处理）。

### Changed

- 动机定义收成单一来源 `lib/motivations.js`（id / 权重 / 原语 / 素材关键词 / 是否允许单段读）；
  `proposer.js` 白名单、`grid.js` 的权重与原语表、`grid.js` 与 `gate.js` 两份单段读白名单
  全部从这张表派生，加一档动机不再要改五处。
- stage2 的动机专属闸改成注册表 `STAGE2_MOTIVATION_RULES`（code / 适用动机 / 判断函数 / 降级动作），
  GA18~GA20 由表驱动；GA1~GA17 这类按字段判、全动机通用的关仍留在原位。
- 「已定方案」探针收成 provider：`engines/proposer.js` 不直接碰 sqlite，
  `buildGrid` 只收池数组，保持纯函数；读不到库只记日志、回空池，不打崩整拍。

## 1.0.1

### Added

- P9「写方案」原语与第九类对象 `plan`（计划大纲）：`draft × plan` 产出 `plans/*.md` 这类文档，
  解决 backlog 类素材配不到「先读工单、再写方案」这一格的问题。

### Changed

- 配对矩阵改由「操作 → 允许的对象类」约束表（`PAIR_CONSTRAINTS`）在运行时枚举，取代手写的稀疏矩阵；
  格号按原语序 × 对象序稳定编号，后加原语/对象只许追加末尾，已有格号不会漂。
- stage1 候选抽改加权随机（无放回），seed 写进日志、state 与 `plans.jsonl`；
  拿 seed 重跑 `buildGrid` 能复现抽到哪一格。不传 seed 仍是确定性排序，供单测与回放。
- 素材正文出现「方案文档 / plans/ / 工单」这类词时，抽取权重向对应格子倾斜（倍数 1 / 2.5 / 0.4），
  修「写方案的素材被配成读服务」这类错配。

### Removed

- 提议器默认工具面去掉 `sbi_search`、`sbi_status`：`DEFAULT_PROPOSER_ALLOW` 与插件自带的
  `cordis.patch.yml` 同步删掉这两条。理由：提议器只负责想一个具体点子，不查语料库，
  这两个工具在提议阶段用不上。影响：插件默认清单 13 → 11 项；沿用自带默认值的配置会少这两个工具，
  需要时显式写回 `allow`。下游若在 profile 里手写 allow（常见做法），那份清单要从 15 → 13 项，其余工具面不变。
- `IDEA_OBJECT_HINTS` 默认名词表（`objectHints` 配置项仍可按需传词表）。

## 1.0.0

首个开源版本。

- 主动念头两段式：提议器 agent 想点子，终审 agent 四选一（silent / ask / do / rewrite）。
- 裁决器四步：gate → veto → arbiter → judge；票台闸、连败退避、安静时段、峰价时段都可配。
- 路径全部改成 `os.homedir()` / `DSH_EGO_*` 环境变量优先，去掉本机绝对路径：
  `DSH_EGO_ROOT`、`DSH_EGO_REPO_ROOT`、`DSH_EGO_PLANS_PATH`、`DSH_EGO_PRICE_CLOCK`。
- 谷价时钟改为外部 `dsh-price-clock` 可选依赖，缺失时用内置峰价规则兜底（不含节假日表）。

### 迁移

`plansPath` 默认值变更：

- 旧：工作区同级的 `dsh-ego.plans.jsonl`（如 `/home/<user>/fatfish/dsh-ego.plans.jsonl`）
- 新：`~/.dsh-ego/plans.jsonl`

从旧版本升级时，设 `DSH_EGO_PLANS_PATH=/home/<user>/fatfish/dsh-ego.plans.jsonl`
或在配置里写 `plansPath`，否则重放读不到旧计划文件。
