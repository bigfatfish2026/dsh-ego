# Changelog

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
