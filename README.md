# dsh-ego

一个 agent 宿主插件：让 agent 在没人叫的时候，自己冒出**主动念头**。两段式——先让一个只读的**提议器 agent** 想一个具体点子，再让一个上下文干净的**终审 agent** 决定这件事该不该落到用户眼前。

## 什么时候会醒

每个周期起点（默认整点）后的 `0 ~ delayMaxMinutes` 分钟之间随机醒一次（默认 8 分钟内，别让用户摸出这是定时器）。周期由 `tickIntervalMinutes` 配，默认 60 分钟；调成 10 就是每 10 分钟判一次，命中线不变，实际干活会明显变勤。醒来之后依次过几关，任何一关不过就睡：

1. `enabled` 得是 true，而且 `proposer.enabled` / `judge.enabled` 都开着；
2. 不在安静时段（`quietStart` ~ `quietEnd`，默认 23:40 ~ 08:00）；
3. `offPeakOnly` 时不在峰价（工作日 09:00-12:00、14:00-18:00）；
4. 票台闸（`skipWhenTicketsBusy`，默认开）：dispatcher 票台上存在 open / running / waiting / blocked 任意一张票就轮空，查不到票台也按不空处理；只记一行 `[ego] 轮空：票台有 N 张未终态票（open/running/waiting/blocked）` 和 `state.busySkips` 计数；
5. 掷骰子掷中（`diceProbability`，默认 35%）。

还有两条不看整点：`retryAfterAt` 没到之前不干活（连败惩罚）；存着的 `pendingSayQueue` / `pendingTicketQueue`（有序队列，各自 FIFO）每一拍都先试着补发/补开一次，一次一条，成功才出队。

排期本身是一个一次性 `setTimeout`（`armWake`）推到「整点 + 随机」那个点，`nextRunAt` 只是记在状态里给人看和降级用。热加载（撤旧 fiber → 挂新 fiber）、进程挂起、时钟跳变都可能把这个 timer 弄丢，所以有两道兜底：apply 收尾按已有 `nextRunAt` 重新 arm 一次；另有一条 25 秒的低频轮询（`lib/safety-poll.js`）盯着 `nextRunAt`，过期且没有在跑的拍就补一拍。它只读内存里的三个字段，不读盘、不碰服务句柄。

## 手动催一拍（调试）

不等整点和骰子，现在就要看链路跑通：

```bash
touch ~/.dsh-ego/force
```

插件每 15 秒看一眼这个文件（`forceIntervalMs`），看到就**先删掉**、再立刻跑一拍。日志里会有 `[debug] 手动催拍，跳过掷骰`。

这一拍**跳过**：骰子（强制命中）、安静时段、峰价窗口、`nextRunAt` 排期、连败推后 `retryAfterAt`。

这一拍**保留**：`enabled` 总开关、`privateOnly`（目标不是私聊就拒）、必须有目标会话、同一时刻只跑一拍（上一拍还在跑就拒，不排队）。

跑完**不动** `nextRunAt`，正常排期照旧；`failStreak` 按正常拍处理（成功清零、失败 +1）。因为 debug 拍不看时段，看日志时先找 `[debug]` 那两行，别把 debug 拍当成「它半夜自己醒了」。

新增配置项要重启宿主才生效。

## 开机自报

每次宿主重启、插件起来后，等 `agents` 服务就绪**且目标会话真在活表**（`ctx.agents.get()` 查得到、没在忙）就立刻往主会话 `followup` 一句，让用户知道它醒了。不用 `setTimeout` 猜时间：时机来自 Cordis 的 `internal/service` 事件，插件安装时先探一次（agents 可能比 ego 早挂、事件已错过），之后每来一次 agents 就绪事件再试。

- 走的是跟终审 `ask` **完全同一条** `followup` 路：`dryRun` 只记日志、`privateOnly` 照旧判、目标会话不在活表就先存进 `pendingSayQueue`；
- 每进程只成功报一次；`targetSession` 还没学到（state 里也没有）就先等，学不到就记一行日志不发，绝不自己造一个假会话；
- **有上限的兜底**：等够 `announceDelayMs`（默认 10 秒）还没发出去，就按老路发一次，并 warn 一条写明「走了兜底」——宿主哪天不给 `agents` 就绪事件（或事件早于 ego 加载错过）也不许静默不发。就绪事件和兜底只发一条：任一边成功/试过就收口（`lib/announce-gate.js`）；
- **目标会话不在活表时事件来了也不发**，继续等兜底：宿主重启后 `sessions` 表是空的，主会话的 agent 要等第一条入站消息才会 `resume`（`getOrCreate → openSession`），在那之前 `ctx.agents.get()` 查不到，出站路由也没有能认的 record。兜底发的时候如果还是这样，话先落 `pendingSayQueue`，然后起一段 `announceRetryWindowMs`（默认 30 秒）的补发盯梢：每秒看一眼目标会话活没活，一进活表就走 `retryPending` 补发一次——补发成功 `ask` 会 ack 掉队列条目，所以只发一次，不会跟「已发」状态打架（`lib/announce-retry.js`）。窗口过了还没活就交给每分钟那一拍/整点那一拍的 pending 重试，学习监听收到用户私聊消息时也照旧起 2 分钟补发盯梢；
- 发出去的文本是「版本号 + 一句醒来的短指令」：`dsh-ego 1.0.0 刚重启完，先看有没有该验的事，有就去做，没有就跟用户打句招呼，短。` 前两行框提示（「自己心里冒出来的念头」「这是你自己开的一轮」）照旧，第三段就是这句。整句可以用 `announceTemplate` 换掉（`{version}` 会换成版本号），不配就走上面这句默认值。**默认值不写「下一拍」**：那个时间是插件加载那一刻算的旧值，排期一变就成了假话；
- 日志里「配置的模板」和「实际文本」分两条记，别把内部指令混在一起；
- 只在启动那一次发，正常 `tick` 不碰它。

## 否决台账（裁决器·第二道关）

裁决器是 `gate → veto → arbiter → judge` 四步（arbiter 默认开启）：gate 判语法和结构，veto 判「用户是不是已经否过这个方向」，judge（终审）判值不值得做。台账是「用户已经表过态」的只读事实库，提议器一个字都不看——让它自己读台账会把「可能又被否」的候选悄悄删掉，候选越剪越窄，所以判断全放在裁决侧。

- **文件**：默认 `~/.dsh-ego/veto.jsonl`（可用 `vetoPath` 或 `DSH_EGO_ROOT` 换位置），UTF-8、一行一条 JSON、append-only；不跟 `state.json` 放一起，也不进 state。
- **写入**：人工/主会话在丢票那一刻写一行；方向否决写、技术失败不写、含糊按技术失败，不加自动来源标记。ego 的裁决器自己**不调用**写入，`lib/veto.js` 的 `recordVeto` 只是把归一路径、脱敏、字段上限收成一个函数，免得手写 JSON 写歪（同一张票重复写由读侧按 `ticketId` 去重）。
- **判据**（窗口 60 天，按 `ticketId` 去重）：
  - V1 格对相同 + `objectNames` 有交集 → 拒；
  - V2 同 `objectKind` + `actionPrimitive` 被两张不同票否过 → 拒；
  - V3 同方向被三张不同票否过 → 拒，并打 `veto_escalate`，提醒「可能不是点子错，是素材或 gate 缺东西」；
  - 单段读没有动作原语，只走 V1。
- **命中处置**：这一拍不进 judge、不 rewrite、不涨 `failStreak`，`lastAction=silent`，跟 gate 拒一个待遇；日志是 `veto_hit:<combo|action|escalate>｜格对｜对象名｜时间`，跟 gate 的 `ga_hits` / `gate 拒了…` 分开数。
- **格式示例**：

```json
{"ts":1794328995600,"ticketId":"t-0","comboKey":"inspect|config→edit-config|config","objectNames":["/srv/app/config.yml"],"readPrimitive":"inspect","objectKind":"config","actionPrimitive":"edit-config","brief":"补上备份盘用量监控","reason":"方向否决：这块盘不会写满，不用进磁盘监控","verdict":"dropped"}
```

- **过期/手工清**：没有 TTL 删除、没有自动清理或归档（规则明确不做，文件只增），读取时只看最近 60 天，超窗记录不参与判定；要清就删文件或清空，下一拍自动当空账。文件不在、读坏、坏行都当空账，只在日志记 `veto_skip:<n>`，不拦这一拍。
- **judge 侧**：judge 提示词里会拿到最近 5 条被否方向（60 天内、按票去重），撞上同方向只许输出 `silent`；规则关（veto）不用自然语言。
- **配置**：`vetoEnabled`（默认 true）、`vetoPath`（默认 `~/.dsh-ego/veto.jsonl`）；60 天窗口写死在 `lib/veto.js`，不做成配置项。

## 想法重放（改 gate 前的回归）

每版 stage2 方案都会落一行盘：gate 拒的、veto 拒的、`step1.verdict=abort` 的、空拍（`pick` 空串）、被 judge/gate 打回重写的都写，判完的也写。以前方案正文只在日志里剩一句 `ga_hits` 摘要，改完 gate 想知道「刚才被误伤的那条 plan 现在过不过」，只能等下一拍随机产出类似想法——120~250 秒一次、还未必撞上。现在旧 plan 就在盘上，原地重跑一遍就行。

- **文件**：默认 `~/.dsh-ego/plans.jsonl`（配置项 `plansPath`，或 `DSH_EGO_PLANS_PATH`），一行一条 JSON、append-only，跟 `state.json` / `veto.jsonl` 分开存。
- **一行是什么**：`ts` / `callId` / `comboKey` / `candidate`（pick 编号 + 读与动作的原语×对象 + 动机 + 种子）/ `plan`（整份方案原文，不截断）/ `gate`（`ok`、`hits`、`items` 逐条 `{ga, action, why}`，action 是 reject / downgrade / unsupported）/ `veto`（`{ok, hit, ran}`，没走到 veto 就写 `null`）/ `judge`（`{action, reason}`，没叫终审就写 `null`）/ `outcome` / `round`（第几轮重写，首轮 0）。一行一份 plan，不合并。
- **脱敏**：写之前整份记录按字符串值过一遍 `redactVetoText`（`sk-` / `ghp_` / `github_pat_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / `crsr_` / `oc_` 全覆盖，换 `***`），遮完仍是合法 JSON。
- **写失败不影响裁决**：序列化、轮转、append 全包在 try/catch 里，磁盘满 / 权限错 / 路径不存在都只记一行 `plans_log_fail:…`，这一拍照旧往下判。append 用 `appendFileSync`（O_APPEND + 一次 write），单行不与别的写者交错。
- **轮转**：每次 append 前看一眼，文件超过 20MB 或超过 3000 行就改名成 `.1`（覆盖旧的 `.1`），新文件从空开始。行数不每次全量数，按 `stat.size` 命中进程内缓存，对不上才重数。

跑回归：

```bash
node scripts/replay.js                              # 最近 50 条
node scripts/replay.js --limit 200 --since 2026-01-01
node scripts/replay.js --ga GA10 --changed          # 只看历史命中过 GA10、且现在有变化的
node scripts/replay.js --arbiter --max-cases 8 --limit 5   # 连 arbiter 一起重放（会调模型、花钱）
```

`--arbiter` 会把 gate 判不了的灰色条目（`unsure`）打包交给 arbiter 逐条判，**这一步会真调模型、会产生费用，所以默认关**；不开时只看 gate + veto，一分钱不花。`--arbiter-model <name>` 只换模型名（provider 沿用 headless 默认路由），`--max-cases N` 限一次送几条（默认 8，1–24，跟线上同一套截断规则）。开了之后汇总行后面多一行 `arbiter：送 X 条｜pass a｜reject b｜downgrade c｜失败 d`，逐条明细里追一句 `arbiter:GA10｜downgrade｜why:…`。arbiter 判 reject 或 downgrade 都会让条目算「变差」（旧 gate 放行、新链路拒/打回），所以开了之后退出码 1 会更常见，这是预期。

输出先一行汇总，再逐条列：

```
重放 2 条：变好 1｜没变 1｜变差 0
2026-01-01T13:20:00.000Z inspect|files→edit-file|files 变好：GA10 不再命中（旧：idea 里的数字 0.1、0 找不到出处）
2026-01-01T13:28:00.000Z inspect|config→edit-config|config 没变：ga_hits 没变
```

有「变差」时退出码 1（方便以后接 CI），否则 0；读不到落盘文件退出码 2。过滤口径：`--since` / `--limit` 按本地日算、`--limit` 取最近 N 条，`--ga` 只看那行历史上命中过这条 GA 的记录，`--changed` 只列前后有变化的。

代码里也能直接调：`replayPlan(record, { vetoEnabled, nowMs, arbiter, arbiterConfig })` 返回 `{ before, after, changed, notes, veto, pass, arbiter }`（`changed` = `better` / `same` / `worse`，比较只认拒与降级，未核不算坏；`arbiter` 为 `null` 表示这次没跑，对象则是 `{ cases, sent, skipped, verdicts, failed }`）；`replayFile(path, { since, until, limit, ga, onlyChanged, arbiter })` 返回 `{ total, better, same, worse, items, arbiter }`。默认不调模型、不写任何文件、不动 state；只有传了 `arbiter` 才真调模型。

两个已知边界：GA3/GA4 要读盘那半默认不跑（不传 `deps` 就记 unsupported，别把「未核」当「合格」）；GA14 的 `outboundTargets` 白名单默认空表，要复核那一条就从代码里传 `outboundTargets`。所以改 gate 的正确姿势是：先 `node scripts/replay.js --changed` 看旧 plan 有没有被新规则误伤，再决定这次改动收不收。

## 三个结果

| 裁决 | 做什么 | 用户看得见吗 |
| --- | --- | --- |
| `silent` | 只写本地日志和 state | **看不见**，一句话都不发 |
| `ask` | `followup` 主会话 + `flush`，走私聊说一句 | 看得见 |
| `do` | 向主会话 `followup` 一条**开票申请**，由主会话自己开票 | 看得见（票的通知） |

`silent` 是底线：这一支不产生任何消息，也不 followup 主会话，只有日志文件和 state 文件里留痕。提议器自己说「今天没话说」（`idea` 空串）时直接当 `silent`，连终审都不叫，省一次模型调用。

## ego 怎么开票

`do` 这一支 ego **不再自己开票**。以前是借主会话的 agent 身份调 `dispatch_open`，票主和决策者错位，waiting 的票又只能靠 sweep 提醒、没人真收；现在 ego 只往主会话 `followup` 一条「开票申请」，开票、关票、收 waiting 全归主会话。

申请正文固定六行（首行标记 + 五个字段，顺序固定，字段值都压成单行），主会话按行解析：

```
【开票申请·dsh-ego】
callId: proactive-2026-01-01-1
goal: <原文一行>
brief: <原文一行>
intent: <归一化后的 intent JSON，单行；没有就写 null>
note: <为什么想开这张票；dryRun.ok=false 时写清 undo.howto 是什么、能不能撤>
```

- 递送走跟 `ask` / 开机自报同一条 `followup` 通道：`agent.followup({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-ego' } })`，目标会话是配置/学到的 `targetId()`；
- 主会话不在活表、正忙，或者 followup 抛错/超时：申请整条（含 `intent` 和裁决 `reason`）存进 `pendingTicketQueue`，每拍取队头重试，超过 `pendingTtlMinutes` 丢掉；
- 幂等：`callId` 是 `proactive-<年月日>-<序号>`；同内容（`goal` + `brief`）沿用原 `callId`，已经提上去的 `callId` 记进 `state.ticketRequests`（最多 50 条），同一份申请不会一拍一拍重复发；
- 日志只有两种：`ticket_request:sent｜callId:…｜goal:<前 60 字>` 和 `ticket_request:pending｜callId:…｜why:…`；跳过重复的发 `ticket_request:skip`；
- `intent` 原样透传，ego 不再自己放宽 `dryRun`（`relaxDryRun` 函数还留着，但这条路上没有调用点了）。放不放宽、要不要停在 waiting，由主会话判断。

`silent` 是底线：这一支不产生任何消息，也不 followup 主会话，只有日志文件和 state 文件里留痕。提议器自己说「今天没话说」（`idea` 空串）时直接当 `silent`，连终审都不叫，省一次模型调用。

## ask 说的话得让人看懂

`ask` 是唯一会直接发到用户那边的一句话，三样缺一不可：

- **对象 + 数量**：具体是哪张表 / 哪条路径 / 哪个服务或文件，动多少条；
- **为什么**：一句话讲清为什么值得动，带数字或依据；
- **要用户定什么**：一个明确问句，说清做了会怎样、不做会怎样。

硬规矩（`lib/gate.js` 里 `validateAskText` 在解析时逐条查，不合格就整拍失败，宁可不发）：

- 默认 60~160 个**字符**（汉字、标点、字母、数字各算 1 个，大约 50~90 个汉字），一条消息读完；不要列表、不要 markdown；上下限可配：`judge.askMinChars` / `judge.askMaxChars`；
- 不许用「死账」「下刀」「捞不回来」「开刀」「动刀」这类黑话，不许说「按照规则 2」这种内部术语，不许叫用户「您」；这份禁词表可换：`judge.forbiddenWords`；
- 文案里的数字必须来自提议器的 `idea` / `why`，不许自己编；
- 提议器的 `idea` 本身也要带对象和数量（`lib/gate.js` 的 `validateIdea` 查），否则终审没法判，这一拍也算失败。

两层校验都收在 `lib/gate.js`：② 代码规则（`parseProposal` / `validateIdea`）看提议器回复，③ 裁决规则（`parseDecisionReport` / `validateAskText`）看终审回复；`proposer.js` / `judge.js` 只保留原来的导出名做转发。

提示词里带正例（example-db 的 `jobs` 表 55 条 `retry` 记录）和一句让用户看不懂的反例，另外明确要求：只留一个问句、而且必须是**最后一句**；JSON 一次写完整闭合，附一个「写到一半断掉」的反例。

**为什么口径是字符数而不是汉字数**：文案必须写清对象，路径（`data/tmp/export_draft`）、表名（`jobs`）、时间、数字都占字符但不占汉字；给模型讲汉字数它数不准，代码也只能按码点查。上限放到 160 够装一条路径加数字，下限 60 保住三要素；代码用码点数（`charLength`），提示词写「字符」并给汉字参考。

**日志和诊断不切在 160**：日志单行可以长（换行折成空格），超过 4000 字符才截断并写明「日志截断，原文 N 字符」；校验失败时记清楚被拦的是哪一项、原始长度、原文前 200 + 后 100（中间省略多少字也写出来），`parseDecisionReport` 会区分「JSON 没闭合 = 真截断」和「JSON 闭合但文案不合格 = 校验拦的」。

`do` 的 `callId` 是 `proactive-<年月日>-<序号>`。同一条票（goal + brief 都没变）沿用原 `callId`，重放不会开第二张；`brief` 按**列宽**算（汉字 2 列），超过 34 列截断。

**`do` 要带 `intent`（撤回账本那一栏）**：申请正文里的 `intent:` 一行原样递这四栏，ego 不改写；票是主会话开的，`origin` 也归主会话写，ego 不再伪造身份。`intent` 四栏：

- `reversibility`：`auto`（能自己撤回来）/ `manual`（要按 `undo.howto` 动手撤）/ `none`（撤不回来）；
- `impact`：`paths` / `services` / `remotes`，三类可空，但 `manual` 时不许全空；
- `undo.howto`：一句话写清撤回的具体命令，空话（太短、命中「稍后处理」「看情况」这类）在 `gate.js` 里被拒；
- `dryRun`：`{ok, detail}`，只透传，不硬校验。

`reversibility: none` 的 `do` 不许出：`gate.settle()` 在 `routeDecision` **之前**把 decision 改成 `ask`（`ticket` 清空、`reason` 追加降级原因），而不是让 `openTicket` 返回 false——后者会记一次失败、连涨 `failStreak`，把「这一步不该由机器做」记成「机器坏了」。申请没发出去先存进 pending 队列时，`intent` 和 `reason` 跟着条目一起存，补发那次照样带。

## 候选行的读建议

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

## 从旧版本升级（1.0.0）

1.0.0 起，方案落盘的默认路径改了：

- 旧默认：工作区同级的 `dsh-ego.plans.jsonl`（如 `/home/<user>/fatfish/dsh-ego.plans.jsonl`）
- 新默认：`~/.dsh-ego/plans.jsonl`

升级时**必须显式指定一次**，否则重放会看不到旧计划文件：

```bash
export DSH_EGO_PLANS_PATH=/home/<user>/fatfish/dsh-ego.plans.jsonl
```

或者在配置里写 `plansPath: /home/<user>/fatfish/dsh-ego.plans.jsonl`（两者等价，配置项优先）。
新部署不用管，直接用默认路径即可。

## 配置

`cordis.patch.yml` 里全是默认值，插件里 `DEFAULTS` 只兜底。补丁是**整行替换、不做深合并**：没写的键一律用插件默认值，所以只写你想改的那几行也合法，旧的配置片段不用改也能继续用。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后定时器空转，什么都不做 |
| `dryRun` | `false` | 两段模型照跑，但只写日志：不发消息、不开票 |
| `delayMaxMinutes` | `8` | 周期起点后随机延迟上限（分钟）；apply 时夹到「周期 - 1」 |
| `tickIntervalMinutes` | `60` | 「多久判一次」的调度周期（分钟）。默认 60 = 每小时一拍，与老行为一致；只收 1–60 且能整除 60 的整数，非法值回落 60 并写日志。**这是真间隔**：调成 10 就是每 10 分钟真判一次，命中线照旧，实际干活频率会明显上升（票台闸只在正好有票时挡掉那一拍） |
| `skipWhenTicketsBusy` | `true` | 票台闸。dispatcher 票台有 open/running/waiting/blocked 任意一张时这一拍轮空（不提议、不开票、不发消息），只记 `[ego] 轮空…` 日志和 `state.busySkips`；查不到票台也按不空保守跳过。`false` 关闸 |
| `diceProbability` | `0.35` | 命中线（0~1）。没掷中就一分钟都不到 |
| `offPeakOnly` | `true` | 峰价不跑（工作日 09-12、14-18） |
| `holidays` | `[]` | 这些日期（`YYYY-MM-DD`）算谷价，跟 `offPeakOnly` 一起用 |
| `quietStart` | `23.66` | 安静时段起点，小数小时，`23.66` = 23:40 |
| `quietEnd` | `8` | 安静时段终点，`8` = 08:00 |
| `privateOnly` | `true` | 只往私聊说。目标会话不是私聊就丢掉这个念头 |
| `targetSession` | `''` | 空串 = 等用户在私聊里说一句，插件自己学；填了就固定用这个 |
| `pendingTtlMinutes` | `30` | 队列里存着的话/票最多留多久，超过丢掉（队列上限写死 50 条） |
| `openTimeoutMs` | `30000` | 向主会话 `followup` 开票申请的单次超时 |
| `maxFailStreak` | `3` | 连续失败几拍开始惩罚 |
| `backoffMinutes` | `60` | 惩罚时长：每再失败一次，`retryAfterAt` 往后推这么久 |
| `qqPrefsPath` | `~/.dsh-ego/model-prefs.json` | 聊天前端的模型偏好文件，探当前 provider/model 用；读不到就用空偏好（名字是历史包袱） |
| `prefsService` | `qqbot/prefs` | 聊天前端挂在 ctx 上的偏好服务名；没有这个服务就退回读 `qqPrefsPath` |
| `statePath` | `~/.dsh-ego/state.json` | 状态文件（原子写：tmp + rename） |
| `logPath` | `~/.dsh-ego/dsh-ego.log` | 日志，一条一行，别指望它自动轮转 |
| `plansPath` | `~/.dsh-ego/plans.jsonl`（`DSH_EGO_PLANS_PATH` 可覆盖） | 方案落盘（一行一条 JSONL），重放回归的原料；超 20MB / 3000 行自动轮转成 `.1`（见上节） |
| `forceTriggerPath` | `~/.dsh-ego/force` | 调试用：这个文件一出现就立刻跑一拍（见上节） |
| `forceIntervalMs` | `15000` | 多久看一眼上面那个文件（15 秒），`unref` 掉不拦进程退出 |
| `announceOnStart` | `true` | 每次重启后跟用户说一句「醒了」，每进程一次（见上节） |
| `announceDelayMs` | `10000` | 兜底等待上限：等 `agents` 就绪信号最多等这么久，到点按老路发一次并 warn。名字是历史包袱，不再抖动 |
| `announceRetryWindowMs` | `30000` | 兜底没发出去后的补发窗口：窗口内每秒看一眼目标会话活没活，活了立刻补发一次（`0` = 不盯，交给每拍重试）。合兜底 10 秒最晚开机后约 40 秒收口，不会拖到一分钟 |
| `announceTemplate` | `dsh-ego {version} 刚重启完，先看有没有该验的事，有就去做，没有就跟用户打句招呼，短。` | 开机自报的整句模板，`{version}` 换成插件版本号（版本读不到就留空、多余空格压成一个）。只换人称或整句重写都行；空串、纯空白、超 500 字符会被 schema 拒。不配就用上面这个默认值 |
| `proposer.enabled` | `true` | 提议器开关 |
| `proposer.provider` | `''` | 空串 = 用宿主自己的默认路由；要指定就填服务商 |
| `proposer.model` | `''` | 同上，填模型名 |
| `proposer.maxTokens` | `2000` | stage1 那一档的输出预算，区间 2000–16000：越界夹到边界并 warn，不拒加载。`0` 是旧的「不限」写法，现在按默认 2000 归一。stage1 目前是纯规则枚举、0 次模型调用，这一项是留好的接口 |
| `proposer.reasoningEffort` | 不填 | 推理档位 `low`/`high`/`max`。不填就不往 `agentOptions` 里写，走服务端默认；写了非法值（如 `medium`）schema 直接拒，`routeOptions` 里还会再白名单过滤一次 |
| `proposer.timeoutMs` | `600000` | 硬超时（10 分钟），到点 abort + dispose。实测一轮能打十几次工具往返，给足时间 |
| `proposer.allow` | 13 个只读工具 | 只读：想点子不许动手（`read`/`glob`/`grep`/`chat_recall`/`memory_recall`/`memory_entity`/`sbi_search`/`sbi_status`/`web_search`/`web_fetch`/`host_status`/`host_alerts`/`read_image`） |
| `proposer.materials` | 空（默认清单在 `cordis.patch.yml`） | 素材池：写进提示词的思考方向，每条是 `{ text, motivation }` 对象。仓库自带的 `cordis.patch.yml` 写了 9 条通用方向（待办、仓库、配置、备份、收件箱、记忆、主机状态、优化插件自己）。`motivation` 只能填 `backlog`/`hygiene`/`sync`/`social`/`memory`/`status`/`self` 七档；写错不拒加载，那条会被剔掉并写日志。代码里只留空兜底，不配就不列方向。最后那条「优化 dsh-ego 自己」有 48 小时冷却：`state.lastSelfIdeaAt` 是上次自指点子的时间，冷却期内 `filterMaterialsByCooldown` 只把喂给模型的那份列表里 `text` 含 `dsh-ego` 的条目临时剔掉，不动配置 |
| `proposer.maxCandidates` | `24` | stage1 规则枚举的候选上限（原语 × 对象组合最多列这么多条） |
| `proposer.stage2MaxTokens` | `8000` | stage2 的输出预算，区间 2000–16000：越界夹到边界并 warn。stage2 要输出 `object`/`evidence`/`plan`/`intent` 一大串字段，所以比 stage1 宽；`0` 按默认 8000 归一 |
| `proposer.maxRewrite` | `3` | 打回重写最多几次，允许 1~5：越界夹到边界并 warn，不拒加载。用满还判 `rewrite` 就落成 `ask`，绝不开票 |
| `proposer.primitives` | 见 `cordis.patch.yml` | 原语开关，关掉的原语整条不进候选：`inspect`/`editFile`/`editConfig`/`service`/`memoryWrite`/`delete`/`outbound`/`externalResearch` |
| `proposer.objects` | `true` | 对象类别开关：`files`/`config`/`service`/`memory`/`ticket`/`session`/`externalDoc`/`externalRepo` |
| `proposer.research` | `ttlDays: 7`、`maxFetchesPerRound: 3`、`peakOff: true` | 外部检索的缓存 TTL、单拍抓取上限、峰价时段禁网 |
| `proposer.readHints` | `{}` | 读建议的配置覆盖：`{ 对象类别: [路径或读法, ...] }`。配了的类整类替换运行时枚举结果，没配的类照旧枚举（来源见上一节）。非法值忽略并写日志，不拒加载 |
| `judge.enabled` | `true` | 终审开关 |
| `judge.provider` | `''` | 空串 = 用宿主默认路由（同 proposer） |
| `judge.model` | `''` | 同上 |
| `judge.maxTokens` | `4000` | 终审的输出预算，区间 1000–8000：越界夹到边界并 warn。以前不设上限、由服务端默认定，曾有一拍被截在 870 字符、JSON 没闭合，整拍判 judgeFail；`0` 现在按默认 4000 归一 |
| `judge.reasoningEffort` | 不填 | 同上：`low`/`high`/`max`，不填走服务端默认 |
| `judge.timeoutMs` | `180000` | 硬超时（3 分钟） |
| `judge.allow` | 4 个 | 终审只看记忆，文件都不用自己翻：`read`/`chat_recall`/`memory_recall`/`memory_entity` |
| `judge.askMinChars` | `60` | ask 文案下限（字符数） |
| `judge.askMaxChars` | `160` | ask 文案上限（字符数） |
| `judge.forbiddenWords` | 10 个内置 | ask 文案禁词：出现就整拍失败。整组可换（`ASK_FORBIDDEN`） |
| `judge.intentRequired` | `false` | 灰度开关。`false`：终审没给 `intent` 的 `do` 照旧放行（老格式行为不变）；`true`：缺 `intent` 的 `do` 按 `reversibility=none` 处理，被降级成 `ask`。等 intent 字段齐全率稳定再打开 |

两段都**没有** `bash` / `write` / `edit` / `dispatch_*` / `send_message`。提议器动手、终审或 ego 自己开票这条路是堵死的。

## 失败怎么兜

- 模型超时 / 抛错 / 返回的不是 JSON：这一拍算失败，`failStreak + 1`，下一拍重新排。
- 正文为空但 `finish=max-tokens`（推理把输出预算吃完了）：报错会直说「模型把输出预算吃完了」，没设上限就去看服务端默认 `max_tokens`，设了上限就调大 `maxTokens`，不再只留一句「没等到 assistant 文本」。日志里还会在叫终审之前先把点子落一行 `点子：…｜理由：…`，终审挂了也丢不了。
- 连败到 `maxFailStreak`：`retryAfterAt = now + backoffMinutes`，之后每再失败一次继续往后推；成功一次清零。
- 目标会话还没学到、会话不在活表、会话正忙：把要说的那句存进 `pendingSayQueue` 队尾，每拍取队头重试，成功才出队；超过 `pendingTtlMinutes` 按条丢；队列超 50 条丢最旧并记一行日志（带丢了几条）。**不会自建假的「主会话」。**
- 主会话不在活表 / 正忙 / followup 抛错或超时：开票申请存进 `pendingTicketQueue`，同上；同 callId 重复入队只留一条、不刷新 at，不同内容的申请各排各的，不会互相覆盖。已经提上去的 callId 记在 `state.ticketRequests`，不重复发。
- `create` 抛错（比如工具名写错）：这一拍失败，日志里带原话。
- 每次跑完 `finally` 里必 `dispose` 临时 agent。`dispose` 不收会话目录，所以两段都有硬超时（提议器 10 分钟 / 终审 3 分钟）。
- 两段开跑和收尾各记一行日志：`提议器开跑（超时 600 秒）`、`提议器跑完，耗时 12.3 秒`（失败写成 `提议器失败，耗时 … 秒：原因`）。下次看日志能直接分出是模型慢还是工具往返多。

## 状态里有什么

`targetSession`（学到的私聊会话）、`nextRunAt`、`retryAfterAt`、`failStreak`、`lastRunAt`/`lastRollAt`/`lastSpokeAt`/`lastAskAt`/`lastReportAt`、`lastAction`/`lastReason`/`lastTicket`（ego 不再自己开票，`lastTicket` 只留给旧状态）、`ticketSeq`、`ticketRequests`（已经提上去的开票申请，最多 50 条）、`pendingSayQueue`、`pendingTicketQueue`、`pendingSeq`、`busySkips`（票台闸累计轮空次数）。

旧单槽 `pendingSay` / `pendingTicket` 只为回滚留着字段形状，新代码不读写；读到老状态的旧值会一次性搬进队列。

`lastReportAt` 是终审判「这事要不要汇报」的依据，成功 `ask` 和成功开票都会更新它。

## 单测

```bash
cd <repo> && node --test test/*.test.mjs
```

568 条，全绿。所有模型 / 工具 / 聊天交互都是注入的假实现，一个字节都不往外发。测试不 import `lib/index.js`（它静态依赖宿主包，插件目录里没装，解析不到），所以路由和开票申请的执行体单独放在 `lib/route.js`。

## License

MIT
