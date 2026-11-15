# Changelog

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
