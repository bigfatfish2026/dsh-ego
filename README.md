# dsh-ego

一个 agent 宿主插件：让 agent 在没人叫的时候，自己冒出**主动念头**。两段式——先让一个只读的**提议器 agent** 想一个具体点子，再让一个上下文干净的**裁决器 agent** 决定这件事该不该落到用户眼前。

## 什么时候会醒

每个整点后的 `0 ~ delayMaxMinutes` 分钟之间随机醒一次（默认 8 分钟内，别让用户摸出这是定时器）。醒来之后依次过几关，任何一关不过就睡：

1. `enabled` 得是 true，而且 `proposer.enabled` / `judge.enabled` 都开着；
2. 不在安静时段（`quietStart` ~ `quietEnd`，默认 23:40 ~ 08:00）；
3. `offPeakOnly` 时不在峰价（工作日 09:00-12:00、14:00-18:00）；
4. 掷骰子掷中（`diceProbability`，默认 35%）。

还有两条不看整点：`retryAfterAt` 没到之前不干活（连败惩罚）；存着的 `pendingSayQueue` / `pendingTicketQueue`（有序队列，各自 FIFO）每一拍都先试着补发/补开一次，一次一条，成功才出队。

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

## 三个结果

| 裁决 | 做什么 | 用户看得见吗 |
| --- | --- | --- |
| `silent` | 只写本地日志和 state | **看不见**，一句话都不发 |
| `ask` | `followup` 主会话 + `flush`，走私聊说一句 | 看得见 |
| `do` | 调 `dispatch_open` 开一张工单 | 看得见（票的通知） |

`silent` 是底线：这一支不产生任何消息，也不 followup 主会话，只有日志文件和 state 文件里留痕。提议器自己说「今天没话说」（`idea` 空串）时直接当 `silent`，连裁决器都不叫，省一次模型调用。

## ask 说的话得让人看懂

`ask` 是唯一会直接发到用户那边的一句话，三样缺一不可：

- **对象 + 数量**：具体是哪张表 / 哪条路径 / 哪个服务或文件，动多少条；
- **为什么**：一句话讲清为什么值得动，带数字或依据；
- **要用户定什么**：一个明确问句，说清做了会怎样、不做会怎样。

硬规矩（`lib/judge.js` 里 `validateAskText` 在解析时逐条查，不合格就整拍失败，宁可不发）：

- 默认 60~160 个**字符**（汉字、标点、字母、数字各算 1 个，大约 50~90 个汉字），一条消息读完；不要列表、不要 markdown；上下限可配：`judge.askMinChars` / `judge.askMaxChars`；
- 不许用「死账」「下刀」「捞不回来」「开刀」「动刀」这类黑话，不许说「按照规则 2」这种内部术语，不许叫用户「您」；这份禁词表可换：`judge.forbiddenWords`；
- 文案里的数字必须来自提议器的 `idea` / `why`，不许自己编；
- 提议器的 `idea` 本身也要带对象和数量（`validateIdea` 查），否则裁决器没法判，这一拍也算失败。

提示词里带正例（example-db 的 `jobs` 表 55 条 `retry` 记录）和一句让用户看不懂的反例，另外明确要求：只留一个问句、而且必须是**最后一句**；JSON 一次写完整闭合，附一个「写到一半断掉」的反例。

**为什么口径是字符数而不是汉字数**：文案必须写清对象，路径（`data/tmp/export_draft`）、表名（`jobs`）、时间、数字都占字符但不占汉字；给模型讲汉字数它数不准，代码也只能按码点查。上限放到 160 够装一条路径加数字，下限 60 保住三要素；代码用码点数（`charLength`），提示词写「字符」并给汉字参考。

**日志和诊断不切在 160**：日志单行可以长（换行折成空格），超过 4000 字符才截断并写明「日志截断，原文 N 字符」；校验失败时记清楚被拦的是哪一项、原始长度、原文前 200 + 后 100（中间省略多少字也写出来），`parseDecisionReport` 会区分「JSON 没闭合 = 真截断」和「JSON 闭合但文案不合格 = 校验拦的」。

`do` 的 `callId` 是 `proactive-<年月日>-<序号>`。同一条票（goal + brief 都没变）沿用原 `callId`，重放不会开第二张；`brief` 按**列宽**算（汉字 2 列），超过 34 列截断。

## 配置

`cordis.patch.yml` 里全是默认值，插件里 `DEFAULTS` 只兜底。补丁是**整行替换、不做深合并**：没写的键一律用插件默认值，所以只写你想改的那几行也合法，旧的配置片段不用改也能继续用。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后定时器空转，什么都不做 |
| `dryRun` | `false` | 两段模型照跑，但只写日志：不发消息、不开票 |
| `delayMaxMinutes` | `8` | 整点后随机延迟上限（分钟） |
| `diceProbability` | `0.35` | 命中线（0~1）。没掷中就一分钟都不到 |
| `offPeakOnly` | `true` | 峰价不跑（工作日 09-12、14-18） |
| `holidays` | `[]` | 这些日期（`YYYY-MM-DD`）算谷价，跟 `offPeakOnly` 一起用 |
| `quietStart` | `23.66` | 安静时段起点，小数小时，`23.66` = 23:40 |
| `quietEnd` | `8` | 安静时段终点，`8` = 08:00 |
| `privateOnly` | `true` | 只往私聊说。目标会话不是私聊就丢掉这个念头 |
| `targetSession` | `''` | 空串 = 等用户在私聊里说一句，插件自己学；填了就固定用这个 |
| `pendingTtlMinutes` | `30` | 队列里存着的话/票最多留多久，超过丢掉（队列上限写死 50 条） |
| `openTimeoutMs` | `30000` | `dispatch_open` 单次调用的超时 |
| `maxFailStreak` | `3` | 连续失败几拍开始惩罚 |
| `backoffMinutes` | `60` | 惩罚时长：每再失败一次，`retryAfterAt` 往后推这么久 |
| `qqPrefsPath` | `~/.dsh-ego/model-prefs.json` | 聊天前端的模型偏好文件，探当前 provider/model 用；读不到就用空偏好（名字是历史包袱） |
| `prefsService` | `qqbot/prefs` | 聊天前端挂在 ctx 上的偏好服务名；没有这个服务就退回读 `qqPrefsPath` |
| `statePath` | `~/.dsh-ego/state.json` | 状态文件（原子写：tmp + rename） |
| `logPath` | `~/.dsh-ego/dsh-ego.log` | 日志，一条一行，别指望它自动轮转 |
| `forceTriggerPath` | `~/.dsh-ego/force` | 调试用：这个文件一出现就立刻跑一拍（见上节） |
| `forceIntervalMs` | `15000` | 多久看一眼上面那个文件（15 秒），`unref` 掉不拦进程退出 |
| `proposer.enabled` | `true` | 提议器开关 |
| `proposer.provider` | `''` | 空串 = 用宿主自己的默认路由；要指定就填服务商 |
| `proposer.model` | `''` | 同上，填模型名 |
| `proposer.maxTokens` | `0` | `0` = 不设上限：不往请求里写 `max_tokens`，交给服务端默认（推理模型会先烧一大段 reasoning，800 这种小上限会被吃光、正文为空） |
| `proposer.reasoningEffort` | 不填 | 推理档位 `low`/`high`/`max`。不填就不往 `agentOptions` 里写，走服务端默认；写了非法值（如 `medium`）schema 直接拒，`routeOptions` 里还会再白名单过滤一次 |
| `proposer.timeoutMs` | `600000` | 硬超时（10 分钟），到点 abort + dispose。实测一轮能打十几次工具往返，给足时间 |
| `proposer.allow` | 13 个只读工具 | 只读：想点子不许动手（`read`/`glob`/`grep`/`chat_recall`/`memory_recall`/`memory_entity`/`sbi_search`/`sbi_status`/`web_search`/`web_fetch`/`host_status`/`host_alerts`/`read_image`） |
| `proposer.materials` | 空（默认清单在 `cordis.patch.yml`） | 素材池：写进提示词的思考方向。仓库自带的 `cordis.patch.yml` 写了 8 条通用方向（待办、仓库、配置、备份、收件箱、记忆、主机状态）；代码里只留空兜底，不配就不列方向。整组可换，换了就以你的为准 |
| `proposer.objectHints` | 空（默认清单在 `cordis.patch.yml`） | `idea` 里必须出现的对象类名词（表、文件、目录……），默认 15 个写在 `cordis.patch.yml`。为空时不按名词卡对象、只要求数量，不会把所有点子判死 |
| `judge.enabled` | `true` | 裁决器开关 |
| `judge.provider` | `''` | 空串 = 用宿主默认路由（同 proposer） |
| `judge.model` | `''` | 同上 |
| `judge.maxTokens` | `0` | `0` = 不设上限（同上）；配正数就原样透传 |
| `judge.reasoningEffort` | 不填 | 同上：`low`/`high`/`max`，不填走服务端默认 |
| `judge.timeoutMs` | `180000` | 硬超时（3 分钟） |
| `judge.allow` | 4 个 | 裁决器只看记忆，文件都不用自己翻：`read`/`chat_recall`/`memory_recall`/`memory_entity` |
| `judge.askMinChars` | `60` | ask 文案下限（字符数） |
| `judge.askMaxChars` | `160` | ask 文案上限（字符数） |
| `judge.forbiddenWords` | 10 个内置 | ask 文案禁词：出现就整拍失败。整组可换（`ASK_FORBIDDEN`） |

两段都**没有** `bash` / `write` / `edit` / `dispatch_*` / `send_message`。提议器动手、裁决器自己开票这条路是堵死的。

## 失败怎么兜

- 模型超时 / 抛错 / 返回的不是 JSON：这一拍算失败，`failStreak + 1`，下一拍重新排。
- 正文为空但 `finish=max-tokens`（推理把输出预算吃完了）：报错会直说「模型把输出预算吃完了」，没设上限就去看服务端默认 `max_tokens`，设了上限就调大 `maxTokens`，不再只留一句「没等到 assistant 文本」。日志里还会在叫裁决器之前先把点子落一行 `点子：…｜理由：…`，裁决器挂了也丢不了。
- 连败到 `maxFailStreak`：`retryAfterAt = now + backoffMinutes`，之后每再失败一次继续往后推；成功一次清零。
- 目标会话还没学到、会话不在活表、会话正忙：把要说的那句存进 `pendingSayQueue` 队尾，每拍取队头重试，成功才出队；超过 `pendingTtlMinutes` 按条丢；队列超 50 条丢最旧并记一行日志（带丢了几条）。**不会自建假的「主会话」。**
- 主会话不在活表 / 看不见 `dispatch_open`：票存进 `pendingTicketQueue`，同上；同 callId 重复入队只留一条、不刷新 at，不同内容的票各排各的，不会互相覆盖。
- `create` 抛错（比如工具名写错）：这一拍失败，日志里带原话。
- 每次跑完 `finally` 里必 `dispose` 临时 agent。`dispose` 不收会话目录，所以两段都有硬超时（提议器 10 分钟 / 裁决器 3 分钟）。
- 两段开跑和收尾各记一行日志：`提议器开跑（超时 600 秒）`、`提议器跑完，耗时 12.3 秒`（失败写成 `提议器失败，耗时 … 秒：原因`）。下次看日志能直接分出是模型慢还是工具往返多。

## 状态里有什么

`targetSession`（学到的私聊会话）、`nextRunAt`、`retryAfterAt`、`failStreak`、`lastRunAt`/`lastRollAt`/`lastSpokeAt`/`lastAskAt`/`lastReportAt`、`lastAction`/`lastReason`/`lastTicket`、`ticketSeq`、`pendingSayQueue`、`pendingTicketQueue`、`pendingSeq`。

旧单槽 `pendingSay` / `pendingTicket` 只为回滚留着字段形状，新代码不读写；读到老状态的旧值会一次性搬进队列。

`lastReportAt` 是裁决器判「这事要不要汇报」的依据，成功 `ask` 和成功开票都会更新它。

## 单测

```bash
cd <repo> && node --test test/*.test.mjs
```

158 条，全绿。所有模型 / 工具 / 聊天交互都是注入的假实现，一个字节都不往外发。测试不 import `lib/index.js`（它静态依赖宿主包，插件目录里没装，解析不到），所以路由和开票的执行体单独放在 `lib/route.js`。

## License

MIT
