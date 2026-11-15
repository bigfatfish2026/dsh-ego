# gate 规则整理（dsh-ego / feature/two-stage）

gate 是裁决器的第一关：纯代码，不调模型，只看提议器（stage2）交上来的那一份 plan 能不能用。它不拼提示词、不发消息、不写 state，只回一份 verdict，形状是 `{ok, allowDo, reject, downgrade, unsupported, unsure, notes, hits, checks}`（gate.js:995-1005）。

在裁决器里的位置是 **gate → veto → arbiter → judge**：gate 先跑 GA1~GA17，判不了的灰色条目收进 `unsure`；过了否决账本（veto）之后，`unsure` 非空才叫 arbiter 逐条判；最后才把方案交给终审。arbiter 这一关见文末。

gate 里有两段：`checkStage2Plan` 是纯函数（不读盘、不看时钟，515 起），跑 GA1/GA2/GA6~GA14 的轻量版加 GA15/GA16 结构；GA3/GA4/GA5 要真读盘，由 `createGate().checkPlan` 拿注入的 deps 补跑（1668 起）。

四种处置：

- **reject**：直接拒。这一拍不动作，不进 veto、不进 arbiter、不进 judge、不重写，只在日志里留一条。
- **downgrade**：降级。带 `code` 且在 `REWRITE_CODES` 里的直接打回重写，不进终审；次数用满后按 `REWRITE_GATE_ACTIONS` 表落到 `silent` 或 `ask`。没有 `code` 的（GA11/GA13）进终审，最终落 `ask`。`downgrade` 这项本身只是「这一版不能出 do」，不等于问用户。
- **unsure**：gate 判不了的灰色条目（详见文末 arbiter 关）。不进日志明细，也不直接放行；打包交给 arbiter 逐条判 pass / reject / downgrade。
- **unsupported**：判定不了，只记日志、不拦，也不代表合格。这一批没有查询源、没注入 deps、或者能改代码判死的结构缺口，都归这一类。arbiter 判 pass、或 arbiter 整体失败时，条目也降级成这一类。

两个汇总口径：`ok = reject 为空`，`allowDo = reject 与 downgrade 都为空`。也就是说只要有一条 downgrade，这一拍就出不了 do。

## 总表

行号以当前 gate.js 为准；GA3/GA4/GA10/GA17 的 unsure 分支另标了行号。

| 编号 | 管什么 | 触发条件一句话 | 命中处置 | 源码行号 |
| --- | --- | --- | --- | --- |
| GA1 | pick 是候选且开关开着 | pick 不在本拍 candidates 里，或那格原语/对象在配置里显式为 false | downgrade（→ silent） | gate.js:554-573 |
| GA2 | 对象类别与 steps 配对 | object.kind 与 pick 那一格的对象不一致，或 steps 里的原语×对象不在配对矩阵里 | downgrade（→ silent） | gate.js:535-568 |
| GA3 | 对象真的存在 | files/config 对象查盘后 missing 或 invalid；service / memory / ticket / session / external* 类没有查询源 | downgrade（→ silent）；非本地类进 unsure 交 arbiter | gate.js:608-624, 679-695, 1717-1773 |
| GA4 | 文件:行号锚点对得上 | 锚点过了形状检查但查盘 missing/invalid；锚点形状不常规或没写 → unsure | reject；形状分支进 unsure 交 arbiter | gate.js:625-635, 696-714, 1777-1807 |
| GA5 | 不许碰 /tmp 与越权路径 | realpath 落在拒绝根内（默认 /tmp），或查盘返回 denied | reject | gate.js:1721-1731, 1752-1762, 1790-1795 |
| GA6 | 撤回档不比默认宽松 | 停服却写非 none；或 reversibility 比候选默认松、impact 栏没填 | downgrade（→ silent） | gate.js:643-679 |
| GA7 | undo.howto 是真命令 | 撤回话术太短/是空话/没字母数字，或没命中该原语的撤回模板 | downgrade（→ ask） | gate.js:681-695, 1229-1245 |
| GA8 | 自指方案要有外部依据 | 提到 dsh-ego 却缺 P8 外部资料，或缺本仓「文件:行号」 | downgrade（→ ask） | gate.js:697-710 |
| GA9 | 外部地址只许 http(s) 外网 | 方案里出现非 http(s) 协议，或指向本机/内网 | reject | gate.js:712-715, 283-326 |
| GA10 | idea 里的数字要有出处 | 遮掉日期时刻后，idea 里每个数字逐个在 evidence[].value 里找字面出处；缺的汇成一条 | unsure（不降级，交 arbiter） | gate.js:671-682, 366-368 |
| GA11 | 峰价禁网 | 峰价时段，且这一格的原语或对象要上网 | downgrade（→ ask，不进重写） | gate.js:735-744 |
| GA12 | 幅度上限 | steps>5、files>3 或 estLines>40 | downgrade（→ ask） | gate.js:746-756 |
| GA13 | 同素材不许连着两拍 | 本拍候选素材与上一拍素材字面全等 | downgrade（→ ask，不进重写） | gate.js:758-763 |
| GA14 | outbound 目标在白名单 | 目标一个都没写，或目标不在白名单里 | reject | gate.js:765-791 |
| GA15 | 两段式结构齐 | step1 三栏不齐 / abort 却写 step2 / 单段读不合规 / continue 缺 step2 | downgrade（→ silent） | gate.js:793-868 |
| GA16 | 第一步是只读 | 读格原语不是 inspect/external-research，或 steps[0] 是动作原语 | downgrade（→ silent） | gate.js:870-883 |
| GA17 | 第一步对象对上素材 | 素材里的字面路径锚点、第一步落点都写成一条事实 | unsure（不降级，交 arbiter） | gate.js:825-848 |

## GA1：pick 必须是本拍候选，且那一格开着

**防什么**：模型自己编一个候选编号，或者提一个配置里已经关掉的原语/对象，把网格绕过去。

**判据**：`plan.pick` 非空时，在 `context.candidates` 里按 `id === pick.trim()` 找，找不到即命中。找到则取 `cells.read` 与 `cells.action` 两格，逐格看 `enabled.primitives[cell.primitiveKey] === false` 与 `enabled.objects[cell.objectKey] === false`。只认**显式 false**，`undefined`（配置没写这一栏）不算关着；同一类只报一条。

**why 模板原文**：

```text
pick=${plan.pick} 不是这一拍的候选，候选只有 ${known}
候选 ${candidate.id} 的${role}原语「${cell.primitiveKey}」在配置里是关着的，不能提
候选 ${candidate.id} 的${role}对象类别「${cell.objectKey}」在配置里是关着的，不能提
```

**处置与重写**：`softFail('GA1')` → downgrade，code=`GA1`，`originalAction='silent'`。进重写循环，用满次数落 `silent`。

**已知局限**：`pick` 为空串时直接 `ok:true, allowDo:true` 放行（541-544），空方案一条都不核；`plan` 不是对象时另有一条 reject 的 GA1「方案是空的，没法核」（532-539），它不带 code、不进重写。

## GA2：对象类别与 steps 配对

**防什么**：方案嘴上说改文件，actual 对象写成配置；以及 steps 里塞一个不相容的原语×对象组合。

**判据**：①`candidate && objectKind && mainObjectKind && objectKind !== mainObjectKind` 即命中（`mainObjectKind` 取动作格优先、单段取读格）。②`context.pairs` 存在时，每个 step 用 `parseStep` 拆成 `{primitive, objectKind}`（认 `P2×files`、`edit-file`、`editfile` 等别名），拆不出或 `pairSet` 里没有 `primitive|objectKind` 即命中。

**why 模板原文**：

```text
pick 的${which}是 ${mainObjectKind} 类（${candidate.id}），方案 object.kind 却写成 ${objectKind}，对不上
plan.steps 里的「${step}」认不出是哪个原语×对象（写法例：P2×files）
plan.steps 里的「${step}」不在配对矩阵里（${parsed.primitive} 不碰 ${parsed.objectKind}）
```

**处置与重写**：downgrade，code=`GA2`，原判 `silent`。进重写，用满落 `silent`。

**已知局限**：`object.kind` 空串时第一条不判，模型不写 kind 就绕过去了；没有 `context.pairs` 时只记 unsupported（604-605）。

## GA3：对象真的存在

**防什么**：方案写「改 lib/xxx.js」「改某个配置键」，那个东西其实不存在，模型在编路径。

**判据**：只在 `objectKind` 是 `files` 或 `config`、`object.value` 非空时产出待核查项（608-612），由 `checkPlan` 用注入的 `deps.checkExists` 去查。返回 `status==='missing'` → 命中「对象不存在」；`'invalid'` → 命中「对象写得不成立」；`'denied'` 归 GA5；其它状态记 unsupported；调用抛错也记 unsupported（1747）。

**why 模板原文**：

```text
对象不存在：${check.value}（${res?.reason || '查不到'}）
对象写得不成立：${check.value}（${res?.reason || '入参不对'}）
核查「${check.value}」时抛错：${String(error?.message ?? error)}，按未核处理
```

**处置与重写**：downgrade，code=`GA3`，原判 `silent`（`softFailGa3`，1717-1720）。进重写，用满落 `silent`。

**已知局限**：`service` 对象永远 unsupported——「host_status 不给 systemd unit 列表，这一批没有查询源，一律按未核处理」（613-617）；memory/ticket/session/external-* 也一律 unsupported（618-623）。所以 GA3 线上只覆盖 files/config 两类。

## GA4：文件:行号锚点对得上

**防什么**：方案引一个不存在的文件，或者行号写飞了（文件只有 50 行却写 `:900`）。

**判据**：`anchor` 必须匹配 `FILE_LINE_PATTERN`（gate.js:54）：`/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|yml|yaml|md):\d+(?:-\d+)?/`。不匹配不拒，只记 unsupported。匹配后交 `deps.checkFileLine` 查盘，返回 `missing` 或 `invalid` 即命中；返回 `denied` 归 GA5。

**why 模板原文**：

```text
锚点「${check.anchor}」对不上：${res?.reason || '行号越界'}
锚点「${check.anchor}」不成立：${res?.reason || '不是文件:行号'}
anchor「${anchor}」不是「文件:行号」形状（unit 名 / 记忆 id / URL@时间），行号这一条不核
```

**处置与重写**：reject（1797、1802）。GA4 不在 `REWRITE_GATE_ACTIONS` 里，不进重写，这一拍直接不动。

**已知局限**：`anchor` 为空时必 unsupported（633-634），不写锚点就免检；只认六种扩展名，`.ts`/`.json` 锚点不会被核。

## GA5：不许碰 /tmp 与越权路径

**防什么**：ego 去动系统临时目录或白名单之外的路径——那地方的东西不归它管，删了也没人认账。

**判据**：`deps.checkExists` 返回 `ok` 时取 `res.path`（realpath），落在 `denyRoots` 里即命中；默认 `denyRoots = ['/tmp']`（1721）。`underDenyRoot` 按路径段比较：`/tmp` 与 `/tmp/x` 都算，`/tmpx` 不算；`tmpAllowlist` 里的路径例外（1725-1731）。`checkExists`/`checkFileLine` 返回 `denied` 也归 GA5。

**why 模板原文**：

```text
对象「${check.value}」落在 ${root} 里（realpath 后是 ${res.path}），这一批不许碰
对象「${check.value}」过不了路径检查：${res?.reason || '不在允许根内'}
锚点「${check.anchor}」过不了路径检查：${res?.reason || '不在允许根内'}
```

**处置与重写**：reject（1752-1762、1790-1795），不进重写。

**已知局限**：`lib/index.js` 调 `checkPlan` 时没传 `tmpAllowlist`/`denyRoots`（index.js:805-814），线上白名单恒空、拒绝根恒 `/tmp`；GA5 只覆盖 files/config 的 `object.value` 和文件:行号的 anchor。

## GA6：撤回档不比默认宽松

**防什么**：把撤不回来的动作写成「可自动回滚」，事后没人兜得住；以及影响面一栏空着就动手。

**判据**：①实例级：`mainPrimitive==='service'` 且 `serviceStopEvidence` 命中 `systemctl ... stop|disable|mask|kill`（或同一句里有 service/unit/服务 + stop/disable），而 `reversibility !== 'none'` 即命中（643-652）。②默认档：`REVERSIBILITY_RANK={auto:0,manual:1,none:2}`，方案没写 reversibility 即命中；写了但 `gotRank < expectedRank` 也命中（660-666）。③impact：`IMPACT_SLOTS[defaults.impact][0]`（`external-repo` + `irreversible` 特判成 `remotes`）对应的 `intent.impact[wanted]` 必须是非空数组。

**why 模板原文**：

```text
方案里要动服务（${serviceStop}）：stop/disable 撤不回，档要写 none（候选 ${candidate.id} 默认写的是 ${...}，方案写的是 ${reversibility || '空'}）
方案没写 reversibility：这一格（${candidate.id}）的默认档是 ${expected}，不写就等于按最宽松的算
reversibility 写宽了：候选 ${candidate.id} 的默认档是 ${expected}，方案写的是 ${reversibility}
intent.impact.${wanted} 是空的：候选 ${candidate.id} 的默认影响面是 ${impact}，要填${label}
```

**处置与重写**：downgrade，code=`GA6`，原判 `silent`。进重写，用满落 `silent`。

**已知局限**：拿不到 `candidate.defaults` 时整条 unsupported（677-678），默认档比较跳过；impact 只看 `slots[0]` 一栏，多栏影响只核第一栏。

## GA7：undo.howto 是真命令

**防什么**：撤回栏写成「整理一下」「看情况」这种态度，不是一条能照着跑的命令。

**判据**：非只读方案才查（两段式看 `mainPrimitive` 是否 inspect/external-research；单段候选 `action===null` 恒按只读跳过，685）。`checkUndoHowto`（1229-1245）：空串、字符数 < `UNDO_MIN_CHARS=10`、命中 `UNDO_EMPTY_TALK` 里 20 个空话词之一（整理一下/检查一下/看情况/酌情/待定/自己判断…）、或整串没有 `[A-Za-z0-9]`，都算不合格。合格但 `UNDO_TEMPLATES[mainPrimitive]` 正则不匹配也命中（690-691）。

**why 模板原文**：

```text
undo.howto 不合格（${howtoCheck.problems.join('；')}），先问一句再动手
undo.howto 没命中 ${mainPrimitive} 的撤回模板（例：${undoTemplateHint(mainPrimitive)}），先问一句再动手
```

**处置与重写**：downgrade，code=`GA7`，`originalAction='ask'`。进重写，用满落 `ask`。

**已知局限**：模板正则写得宽（`cp`、`mv`、`git stash` 都算），假通过容易；只读原语没写 howto 只记一条 note「GA7 跳过」，没有任何校验。

## GA8：自指方案要有外部依据

**防什么**：ego 改自己时凭印象下刀——既没有外部资料，也没指到本仓具体几行。

**判据**：`plan.idea`、`plan.why`、`plan.object.value`、`plan.files` 任一含字面 `dsh-ego` 即算自指（`SELF_REF_PATTERN`，gate.js:47）。然后两条：①evidence 里要有一条 `claim` 或 `value` 带 `https?://`，且有一条 `at` 非空（699-701）；②`anchor` 或某个 `plan.files` 要匹配 `FILE_LINE_PATTERN`（705-706）。缺任一条即命中。

**why 模板原文**：

```text
改的是 dsh-ego 自己，evidence 里没有一条外部资料（带 URL 和抓取时间），先问一句
改的是 dsh-ego 自己，却没给本仓的「文件:行号」锚点，先问一句
```

**处置与重写**：downgrade，code=`GA8`，原判 `ask`。进重写，用满落 `ask`。

**已知局限**：P8 的两半可以落在不同 evidence 条目上（一条有 URL、另一条有 at）就算过，不要求同一条；自指只认 `dsh-ego` 这个词，写「本插件」不触发。

## GA9：外部地址只许 http(s) 外网

**防什么**：方案里塞 `file://`、`ftp://` 或者 `192.0.2.x`、`127.0.0.1`，让 ego 去读本机/内网。

**判据**：扫 `idea`、`why`、`object.value`、`object.anchor`、`plan.files`、`evidence[].claim/value/at`（`urlFields`，283-297）里的所有 `协议://` 串（`URL_PATTERN`，194 行，到空白或中文标点为止）。协议不是 http/https 即命中；host 去掉 userinfo 与端口后命中 `127.0.0.1`、`192.0.2.`、`10.`、`.internal` 也命中（300-314）。

**why 模板原文**：

```text
地址协议是 ${scheme}，只能写 http(s)：${url}
地址指向本机或内网（${host}），ego 只许读外网：${url}
```

**处置与重写**：reject（714），不进重写。这一条没有任何降级余地。

**已知局限**：只认带 `://` 的写法，`//host/path` 与裸 `localhost` 不拦；内网段只列了 127/192.0.2/10，`172.16.x`、`169.254.x` 漏；`10.` 前面没锚定，`10.` 开头的公网域名也会误伤。

## GA10：idea 里的数字要有出处

**防什么**：点子张口就写「37.7 度」「涨了 5 倍」，evidence 里根本没跑过这个数，数字是编的。

**判据**：`evidence[].value` 抽数字成集合；`idea` 同样抽，但先 `maskDatesAndTimes`（`2026-01-01`、合法月日、合法时刻遮成空格）。不再有 `IDEA_NUMBER_MIN`、量纲词表、行号区间特判——每一个数字都核，缺出处的**汇成一条** `unsure`，`why` 里把所有数字列出来。

**why 模板原文**：

```text
idea 里这些数字在 evidence 里没有出处：${missing.join('、')} —— 逐个看是不是编造的测量值，计数和定性说法放行
```

**处置**：unsure，不降级。哪些数字算「编造」是语义判断，gate 只负责把缺出处的数字摆出来；arbiter 一条里逐个数，但只回一个决定（确实有编造的测量值才 downgrade）。

**已知局限**：只核 idea，`why` 和 `step2.change` 里的数字不核；数字是否真由这一拍的工具输出产生，gate 没有按次对账的数据。

## GA11：峰价禁网

**防什么**：峰价时段（半价之外）还让 ego 花大钱上网搜东西。

**判据**：`context.peak === true` 且要上网。要上网按候选格子判：R/A 两格任一 `primitive === 'external-research'` 或 `objectKind` 是 `external-doc`/`external-repo`（两段式是唯一生产形状）。

**why 模板原文**：

```text
现在是峰价时段，这一格要上网（外部检索），先降级成问一句
```

**处置与重写**：downgrade，**不带 code** → 不进重写循环，直接进终审落 `ask`（`REWRITE_GATE_ACTIONS` 里没有 GA11）。

**已知局限**：不看 `evidence.source`，方案正文写「我去搜一下」但格子上是 inspect 就不拦；peak 由 `index.js` 的 `isPeak(new Date(nowMs), cfg.holidays)` 传入（index.js:812）。

## GA12：幅度上限

**防什么**：一版方案想一口气改 8 个文件、40 步、几百行，评审根本过不了。

**判据**：`plan.steps.length > 5`（code=`steps`）；`plan.files.length > 3`（code=`files`）；`Number(plan.estLines) || 0 > 40`（code=`estLines`）。三条独立判，可同时命中。

**why 模板原文**：

```text
plan.steps 有 ${steps.length} 步，超过 5 步，先问一句
plan.files 有 ${files.length} 个文件，超过 3 个，先问一句
estLines 估了 ${estLines} 行，超过单文件 40 行，先问一句
```

**处置与重写**：downgrade，三个分支各带 code，原判 `ask`。进重写，用满落 `ask`。

**已知局限**：estLines 文案写「单文件 40 行」，代码对多文件方案也是同一个 40 上限，不看文件数；estLines 非数字按 0 处理，单位写错直接免检。

## GA13：同素材不许连着两拍

**防什么**：同一格素材被连着选中两拍，ego 反复在同一个点上打转。

**判据**：`context.previousMaterial` 非空，且 `candidate.material.trim()` 与它字面全等即命中（759-761）。`previousMaterial` 来自 `state.lastMaterial`（index.js:813）。

**why 模板原文**：

```text
这一拍和上一拍挂着同一条素材，先问一句再动
```

**处置与重写**：downgrade，不带 code → 不进重写，进终审落 `ask`。

**已知局限**：只比字面全等，素材原文改一个字就绕过去；`lastMaterial` 的写入时机在 index 侧，空拍不记。

## GA14：outbound 目标在白名单

**防什么**：ego 自己决定往哪个会话发消息，发错人。

**判据**：只在 `mainPrimitive === 'outbound'` 时判（771）。目标集合取 `object.value`、`intent.impact` 里的 `target/targets/sessions/session`、`intent.target`、`intent.targetSession`（`outboundTargetsOf`，379-399）。集合为空 → 命中「没写目标」；有目标但任一不在 `normalizeOutboundTargets(context.outboundTargets)` 里 → 命中「不在白名单」。

**why 模板原文**：

```text
outbound 方案没写目标（object.value 与 intent.impact 都没有），outbound 目标不在白名单里
outbound 目标不在白名单里：${outside.join('、')}（现在配的是 ${shown}）
```

**处置与重写**：reject，不进重写，这一拍不动。

**已知局限**：白名单空表 = 一律不许发，而 schema 默认就是 `[]`（index.js:229），空时 `shown` 写「空表（一律不许发）」；`outbound` 原语默认关着，多数情况下 GA1 会先拦，GA14 走不到。

## GA15：两段式结构齐

**防什么**：模型退回老的单格写法——不写「先读什么、读到哪里停、读完动什么」，直接给一个改动。

**判据**：候选必须是两段式（有 `read`/`action` 两栏），否则记 unsupported。①step1 的 `read`/`abortIf` 非空、`verdict ∈ {continue, abort}`，缺一即命中（827-828）。②`verdict==='abort'` 时不许有 `step2.change`（829-833）。③单段读（`action===null`）：动机必须是 `hygiene`/`status`，全拍只许一格（`singleReadCount`），不许写 step2，`idea` 非空，`plan.steps` ≥1，`undo.howto` 要过 `checkUndoHowto`（834-854）。④continue：必须有 `step2` 且 `step2.change` 非空，且 `plan.steps` 里要能解析出 A 那个原语（855-867）。

**why 模板原文**：

```text
两步式结构不齐：step1 要写 read（真读了哪一处）/ verdict（continue 或 abort）/ abortIf（读到什么就停）三栏
step1.verdict=abort 却写了 step2.change：读了判断不动，就不该有第二步
这一拍有 ${singleReadCount} 格单段读，全拍只许一格
plan.steps 里没有动作那一步：候选 ${candidate.id} 的 A 是 ${mainPrimitive}，steps 里得出现它
```

**处置与重写**：downgrade，code=`GA15`，原判 `silent`。进重写，用满落 `silent`。

**已知局限**：没有 read/action 两栏的旧平铺候选不再兼容，会落进「单段读」分支按缺 step2 打回；线上 `buildGrid` 恒出两段式，走不到；abort 且三栏齐的方案 `allowDo=true`，会跳过终审直接收工（rewrite.js:137-139）。

## GA16：第一步是只读

**防什么**：plan.steps 第一步就动刀，先改再读，等于没核。

**判据**：`cells.read.primitive` 必须是 `inspect` 或 `external-research`（`READONLY_PRIMITIVES`，203），否则命中；再把 `plan.steps[0]` 用 `parseStep` 拆开，若 primitive 在 `ACTION_PRIMITIVES`（edit-file/edit-config/service/memory-write/delete/outbound，210）里也命中。

**why 模板原文**：

```text
候选 ${candidate.id} 的读格原语是 ${readPrimitive || '空'}，不是只读原语（只许 inspect / external-research）
plan.steps 的第一步是动作原语（${firstStep.primitive}）：读的那一步要排在动前面
```

**处置与重写**：downgrade，code=`GA16`，原判 `silent`。进重写，用满落 `silent`。

**已知局限**：`steps[0]` 解析不出（写成「先看看」）就放过，不追着要原语；只核第一步和读格，第二步之后有没有重复读不查。

## GA17：第一步对象对上素材

**防什么**：素材说的是 `lib/gate.js` 那十七关，方案第一步却跑去读别的文件——对象和素材对不上。

**判据**：`materialFilePaths` 按字面抽素材里带扩展名的路径，不猜占位符、不按尾部对齐、不判是不是同一处。有锚点就在 `why` 里列出锚点，没有就写「没有可认的文件锚点」；`subject` 带上素材、`step1.read`、`object.value`、`anchor`、`plan.files` 原文。每条都只产生一个 `unsure`（825-848）。

**why 模板原文**：

```text
素材里有文件锚点 ${matPaths.join('、')}：第一步是不是同一处，代码判不了
素材里没有文件锚点（只有方向描述）：第一步的对象跟素材对不对得上，代码判不了
```

**处置**：unsure，不降级。「像不像示例占位符」「父目录不同算不算同一处」都是语义判断，gate 只交事实。

**已知局限**：只抽路径，不抽行号；占位符示例（`lib/x.js`）也会被当成字面锚点，由 arbiter 看过原文再放行。

## 重写与耗尽

`REWRITE_GATE_ACTIONS`（gate.js:439-451）的完整映射：

| GA | 用满次数后落点 | 原本处置 |
| --- | --- | --- |
| GA1 | silent | reject |
| GA2 | silent | reject |
| GA3 | silent | reject |
| GA6 | silent | reject |
| GA7 | ask | downgrade |
| GA8 | ask | downgrade |
| GA10 | silent | reject |
| GA12 | ask | downgrade |
| GA15 | silent | reject |
| GA16 | silent | reject |
| GA17 | silent | reject |

落到 `silent` 的：GA1、GA2、GA3、GA6、GA10、GA15、GA16、GA17，共 8 条，都是原本判拒的关。落到 `ask` 的：GA7、GA8、GA12，共 3 条，原本就是降级。

不在表里的：GA4/GA5/GA9/GA14 保持 reject，不进循环；GA11/GA13 判不了、没有 code，不进循环，仍是普通降级进终审落 `ask`。GA12 的三个分支各带自己的 code（`files`/`steps`/`estLines`），`REWRITE_CODES` 是这 11 个 GA 名加这三个分支（454）。

次数：`DEFAULT_MAX_REWRITE = 3`（proposer.js:141），范围 1–5，`clampMaxRewrite` 把非数字打回默认、非整数截断、小于 1 夹到 1（proposer.js:150-165）。每轮打一行 `stage2_rewrite:${n}｜by:${ga}｜left:${剩余}｜why:${原因}`；用满时打 `rewrite_exhausted:共${rewrites}次｜原因:${ga}｜落回:${originalAction}｜${why}`（rewrite.js:175），然后按 `exhaustedDecision` 出 `silent`（`text=''`、`ticket=null`）或 `ask`。

一个特殊的顺序：`step1.verdict=abort` 本身是合法收工，但只要有可重写的 gate 降级项，先重写、不 abort（rewrite.js:133-139）。

## 日志怎么对

每条判定一行，格式固定（`gateHitLine`，gate.js:469-473）：

```text
ga_hit:GA6｜downgrade｜why:方案没写 reversibility：这一格（C03）的默认档是 manual，不写就等于按最宽松的算
```

- `ga`：规则编号；取不到时写 `GA?`。
- `kind`：`reject` / `downgrade` / `unsupported` 三值之一，跟 verdict 的三个数组同名（`GA_HIT_KINDS`，457）。
- `why`：一句话原因，`clipLogText` 截到 `GA_HIT_WHY_MAX=240` 字符（460），空的话写「（没写原因）」。

明细行顺序固定：先 reject、再 downgrade、最后 unsupported（`gateHitLines`，481-488）。汇总行由 index.js 打，排在明细前面（index.js:816-819）：

```text
ga_hits:GA6,GA7,GA10｜拒 0 条｜降级 3 条｜未核 1 条
```

- 冒号后是 `verdict.hits` 去重后的 GA 编号，逗号分隔，空的话写「无」。
- 「拒/降级/未核」三个数分别是 `verdict.reject/downgrade/unsupported` 的数组长度；同一条规则命中两次算两条，但 `hits` 里只出现一次。
- `hits` 不含 `notes`（比如「estLines 有值但 files 为空」那条只进 notes，不进 hits）。

arbiter 另有四类行（`arbiter_case` / `arbiter_judge` / `arbiter_fail` / `arbiter_case:超 N 条已略`），格式见文末「arbiter 关」的「日志怎么对」。

对日志的办法：先 grep `ga_hits:` 看这一拍被哪几条拦、各几条；再 grep `ga_hit:` 看同编号的 why 原文。`rewrite_exhausted` 行里的「原因」是最后一轮把关的那条 GA，不是整轮的全部。

## 裁决器·arbiter 关（第三关）

gate 有四类条目真的判不了：对象类别没有查询源、锚点形状不常规、idea 里的数字认不出出自哪次输出、素材里没有可机核的文件锚点。它们以前只记 `unsupported` 放行——等于看出可疑却闭嘴。现在这些条目收进 verdict 的第四个数组 `unsure`，打包交给 arbiter 判。

四关各管一段，谁都不许越界：

| 关 | 判什么 | 用什么判 | 越界长什么样 |
| --- | --- | --- | --- |
| gate | 硬语法：形状、超限、白名单 | 纯代码 | 把「核不了」当「不合格」拒掉 |
| veto | 否决台账里有没有这条 | 纯代码 | 拿模型重判台账 |
| arbiter | gate 判不了的灰色条目该不该拦 | LLM，只读 | 去改 gate 判死的关、去开票 |
| judge | 整份方案值不值得做 | LLM | 替 gate 数行号 |

### 送 arbiter 的分支

| GA | gate 原来的分支 | 送 | 为什么 |
| --- | --- | --- | --- |
| GA3 | `object.kind = service`（host_status 不给 systemd unit 列表） | 送 | 服务名对不对得上，能看仓库/配置里的 unit 文件判 |
| GA3 | `object.kind` = memory / ticket / session / externalDoc / externalRepo | 送 | 要运行时上下文，代码这拍拿不到；方案里的值离不离谱，模型看得出 |
| GA4 | anchor 不是「文件:行号」形状（unit 名 / 记忆 id / URL@时间） | 送 | 代码只认文件:行号，别的形状可不可接受要判 |
| GA4 | 压根没给 anchor | 送 | 同上：缺锚点是可疑，不是必错 |
| GA10 | idea 里有数字在 evidence 里找不到出处 | 送 | 是不是编造的测量值要语义判断；gate 只列数字，一条汇总 |
| GA17 | 有锚点 / 没锚点都送 | 送 | 锚点像不像示例、是不是同一处，读原文就能判 |

不送的四类——能改代码判死的别花模型钱：

| GA | 分支 | 为什么不送 |
| --- | --- | --- |
| GA2 | 没给配对矩阵 | 配置永远会传 `PAIR_SET`，这是运行时缺口不是灰度 |
| GA6 | 候选没给 defaults | grid 永远会补 defaults，跟 GA2 同理 |
| GA15 / GA16 | 旧格式平铺候选 | 已删：生产路径只产出 read/action 两栏，平铺候选是死分支 |
| — | checkPlan 注入 deps 读盘失败 | 是工具坏了，不是方案可疑；照旧记 unsupported |

GA5 的 `tmpAllowlist` 也不是灰度：index.js 从来没把它传给 gate，白名单永远是空的。要修的是接线，不是加一关模型；而且接上之后 GA5 会从「总放行」变成「可能拒」，属于改判定口径，单独开票，不夹在 arbiter 里。

### 一次怎么跑

1. gate 把灰色条目 push 进 `verdict.unsure`，每条 `{ga, why, subject}`，`subject` 写清针对方案哪一段（gate.js:686-709、806、978）。
2. veto 过了、`unsure` 非空才叫 arbiter（rewrite.js:233-236），位置钉在 veto 之后、judge 之前。最多送 `maxCases` 条，按 GA 编号从小到大截，截掉的记数。
3. 提示词（`buildArbiterPrompt`，arbiter.js:94-150）只给候选 id、idea、why、object、anchor、step1.read、step2.change、要动的文件、素材，加逐条 `[GA] why` 和「涉及的方案片段」。不给提议器的过程，不给任何下发入口。
4. 回复只认 `{"verdicts":[{"ga","decision","why"}]}`，decision 三选一：pass / reject / downgrade。
5. 合并（`mergeArbiterVerdicts`，arbiter.js:236-303）：pass → 按 unsupported 放行；reject → 进 reject，整拍不做；downgrade → 进 downgrade，在 `REWRITE_CODES` 里的带 `code` 打回重写，不在的进终审。同名 GA 按出现顺序配对；模型编出来的 GA、多出来的条目直接忽略——arbiter 不许碰 gate 判死的关。

### 失败降级

超时（硬上限 120s）/ 调用错 / 空回复 / 坏 JSON：这批条目全按 unsupported 放行，整拍照常进 judge，日志记一条 `arbiter_fail`。arbiter 是补位，不是新的否决权——它挂了只让这一拍退回 arbiter 落地前的行为，绝不拒掉整拍。

### 配置

`cordis.patch.yml` 与 lib/index.js 的 `ArbiterSection`：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| enabled | true | 关掉就退回「灰色条目记 unsupported」 |
| provider / model | 空 | 空 = 宿主默认路由；要指定就跟 judge 一样填 |
| maxTokens | 1500 | 500–4000，越界夹边界并打日志 |
| reasoningEffort | low | 只逐条判，不需要深想 |
| timeoutMs | 120000 | 硬超时，超时按失败降级 |
| maxCases | 8 | 1–24；写 `abc` / 0 回落默认，不拒加载 |
| allow | `['read']` | 只许看，不许改、不许开票、不许 exec |

### 日志怎么对

arbiter 一次跑出四类行（拼行函数在 arbiter.js:305-326）：

```text
arbiter_case:3 条｜送 2 条｜ms:1234｜pass:1｜reject:1｜downgrade:0
arbiter_case:超 1 条已略
arbiter_judge:GA4｜reject｜why:锚点是编的，第 36 行没有重复分支
arbiter_fail:超时｜2 条按 unsupported 放行
```

先 grep `arbiter_fail` 看这一关有没有干活；没失败就按 `arbiter_judge` 逐条对 `arbiter_case` 里的三个数。`arbiter_judge` 的 why 跟 `ga_hit` 同一口径，超 240 字截断并注明原文长度。

### 重放

`lib/replay.js` 默认只重跑 gate + veto（纯代码、不花钱），`unsure` 落到 unsupported 留痕；传 `arbiter`（CLI 是 `--arbiter`）才会把 `unsure` 交给 `runArbiter` 判，再按 `mergeArbiterVerdicts` 的语义合并，`changed` 也按合并后的 reject / downgrade 算——arbiter 判 reject 或 downgrade 都算「变差」。这一步会真调模型、产生费用，所以默认关。
