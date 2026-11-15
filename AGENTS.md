# 给改这个插件的 agent 看的规矩

纯 ESM，没有构建步骤，也没有 tsc / typecheck。

## 改完要跑

```bash
node --check lib/index.js
node --check lib/*.js
node --check lib/engines/*.js
node --check scripts/*.js
npm test                             # = node --test test/*.test.mjs
```

测试数报实际输出，别拿 README 里的旧数字充数。

## 测试边界

测试不 import `lib/index.js`（它静态依赖宿主包，插件目录里通常没装，解析不到），
所以路由/开票申请这类执行体单独放在 `lib/route.js`，方便注入假实现。
所有模型 / 工具 / 聊天交互在测试里都是假的，一个字节都不往外发。

## 改路径与默认值

本机路径一律走 `os.homedir()` 或环境变量，不要写死某台机器的绝对路径：

- `DSH_EGO_ROOT`：工作区根（默认 `~/fatfish`）
- `DSH_EGO_REPO_ROOT`：相对路径回退基准
- `DSH_EGO_PLANS_PATH`：方案落盘文件
- `DSH_EGO_PRICE_CLOCK`：外部谷价时钟模块路径

## 闸类改动怎么验

票台闸、连败退避、安静时段这类「拍内闸」，验证只有两条路：

1. 等自然拍（周期起点 + `delayMaxMinutes` 随机延迟），看日志原文。手动催拍
   和 `ego_tick` 按设计不过拍内闸，拿它们验闸等于没验；
2. 时间等不起就用真探针跑引擎：`lib/ticket-gate.js` 的 `createTicketProbe()`（服务不在会
   readOnly 打开 `~/.dsh/dispatcher/tickets.db`）喂给 `createRoundEngine({ ... ticketProbe })`，
   `tick(nowMs)` 跑一遍看日志。这条只读、不碰线上 state。

**不许为了让闸好验去放宽代码**。

## 票台探针的两个坑

1. `new DatabaseSync(path, { readOnly: true })` **读得到未 checkpoint 的 WAL**：写连接一直开着、
   另起子进程只读，拿到的就是最新数。别加 `immutable=1`，那才会把 `-wal` 当不存在，读出一份
   过期甚至没有表的视图。复现这条必须用子进程——同一进程里看得到 WAL 不算数。
2. 探针的 busy 语义不是「读到 N > 0」：service 或 sqlite **任一源**报 > 0 就算忙；两个源都拿不到
   或都抛错也算忙；只有两源都确实读到 0 才放行。每拍日志都有一行
   `[ego] 票台探针 source=service|sqlite|none count=N busy=0|1（service=…／sqlite=…）`，
   问「那拍为什么放行」直接 grep 这行，两源的读数都在同一行里，别再靠印象。
