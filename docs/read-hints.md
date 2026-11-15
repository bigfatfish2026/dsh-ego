# 候选行的「读建议」

stage1 的候选只有读格的 `primitive` + `objectKind`，没有实例；素材又只是一句方向。模型拿到
`读 inspect×config` 时手上没有路径，只能自己 glob 摸结构，实测 7 次里 4 次空手。

路径由 ego 在**运行时**枚举，不是静态表（静态表会过期、要人维护）。候选行末尾只留一个指针
`读建议：#C01`，真正的路径单列在提示词末尾的「可读位置（按候选编号）」区块里，逐候选一行
`#C01 读建议：<a>；<b>`——不占候选行那 200 字预算（`head + note` 本来就占 140 左右，路径塞进去只放得下一条）。
区块只在 stage2 提示词里出现（stage1 只挑候选，不读文件）：

| 对象类别 | 给什么 |
| --- | --- |
| `files` | `$DSH_EGO_ROOT/logs/*.log` 里按 mtime 最近的 5 个真实路径 |
| `config` | `~/.dsh/profiles/<name>/cordis.patch.yml`、`$DSH_EGO_ROOT/plugins/<name>/cordis.patch.yml`、`~/.dsh/settings.yaml`，存在才列 |
| `service` | 不给路径：`用 host_status 看 CPU/内存/磁盘/温度这几栏，unit 列表拿不到` |
| `memory` / `ticket` / `session` | 给读法：`memory_recall` / `dispatch_list` / `chat_recall` |
| `external-doc` / `external-repo` | `种子关键词走 web_search` / `git -C 仓库目录 看 status 和同步状态` |

边界：每个根只 `readdir` 一层，再 `stat` 固定文件名（`profiles/<name>/cordis.patch.yml` 是写死的两层），
不递归、不碰 `node_modules`、不扫 `/`；单个根读不到（不存在 / 没权限）就跳过，不让整拍挂掉；
整表进程内按 60 秒 TTL 缓存，一拍最多扫一次盘。每类最多 5 条，超出截断并标「还有 N 条」。
末尾区块里每个候选一行：最多列 5 条（超了写「…等 N 条」，N 是这一格总条数），整行封顶 300 字
（超了在条目边界截，不把路径切成半截）；整段封顶 1200 字，超了按候选顺序截断并写
「（后 N 条候选的读建议已省略）」。候选行自己仍封顶 200 字，只是那一栏不再塞路径。

要覆盖就配 `proposer.readHints`（key 是对象类别，value 是字符串数组）：配了的类**整类替换**枚举结果，
没配的类照旧枚举。非法值（不认识的类别、不是数组、数组里混了非字符串）忽略并写日志，不会拒加载；
空数组按没配处理。

```yaml
proposer:
  readHints:
    files:
      - ~/fatfish/logs/app.log
    config:
      - ~/.dsh/settings.yaml
```

实现：`lib/read-hints.js`，接进 stage2 提示词的位置在 `lib/proposer.js`（区块文案）与 `lib/index.js`（每次 tick 取一次）。
