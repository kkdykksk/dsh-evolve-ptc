# 进化 PTC 模式（dsh-evolve-ptc）

一个新的 DeepSeek Harness 模式：`evolve-ptc` /「进化 PTC 模式」。它不是又一个 PTC 外壳，而是把三件
在官方 PTC 里靠「自觉」完成的事变成**有状态、可观测、会升级**的机制：

| 支柱 | 官方 PTC | 进化 PTC |
| --- | --- | --- |
| 电脑自我操纵 | 说清楚要观察再动手 | 写操作前必须有成功观察、写操作后必须回读验证，否则检测器直接命中 |
| 创造模式 | 把插件源码留在内存里跑一次 | 脚手架 → 静态校验 → 桩 ctx 试跑 → 安装 → 健康检查 → 失败自动回滚 → 教训入规则库 |
| 自纠错 / 自进化 | 靠 persona 提醒 | JSONL 任务账本 + 四个检测器 + 连续命中升级为硬拦截 + 跨会话规则库（带版本与回滚） |

## 装了什么

- 预设 **`evolve-ptc`（「进化 PTC 模式」，order 7）**：加载时读取**已安装 Harness 自带的官方
  `ptc.patch.yml`**，原样继承它的每一行，只替换 persona 前缀、在末尾追加运行时行，并按配置补创造模式
  的行。官方 PTC 升级后，这一模式跟着升级，不需要改本插件。
- 运行时行 **`evolve-runtime`**（`dsh-evolve-ptc/runtime`）：注册 `evolve` 工具、每步刷新
  `[EVOLVE 进程]` 系统提示段、跑检测器与硬拦截、注册 `/evolve-status` 命令。按会话隔离，切到别的模式
  就完全不存在。
- 设置卡片（设置 → 进化 PTC）与插件列表图标，界面随 DSH 语言切换中英。

## 安装

```bash
# 在目标 profile 里安装（本地目录是 link 安装，改代码即时生效）
plugin_manager({ action: "install_bundle", target: "<本目录绝对路径>" })
# 或者命令行
dsh plugin --profile <profile> add <本目录绝对路径>
```

- 新 bundle 可由 HMR 直接激活；**替换已安装版本需要重启应用**。
- 安装后进「设置 → 插件」确认 `dsh-evolve-ptc` 的 application 是 `applied`，`$DSH_HOME/evolve/status.log`
  会写下注册结果（预设来源、行数）。
- 新建对话 → 模式下拉框选「进化 PTC 模式」。
- 卸载：`plugin_manager({ action: "remove_bundle", target: "dsh-evolve-ptc" })`。

## 每步看到什么

系统提示里每步出现一段 `[EVOLVE 进程]`（≤1200 字符）：

```
[EVOLVE 进程]
计划 2/5 · 阶段：校验布局
✔ 1 观察桌面  ✔ 2 打开设置
○ 3 校验布局  ○ 4 复制结果  ○ 5 回读确认
最近教训：截图确认点击生效后再继续下一步
规则：r-3f2a 先量坐标再点，因为 DPI 缩放会让估算偏移
⚠ 硬拦截 computer_click 生效中（先 reflect）
```

内容不变时不重新注册段落（不打断 KV cache）。它同时是给用户看的进度面板：不记账的助手会看到
「计划已登记但一条 note 都没有」的提醒。

## `evolve` 工具

| action | 用途 | 关键参数 |
| --- | --- | --- |
| `status` | 看会话账本、规则数、当前环境与硬拦截 | — |
| `plan` | 登记/更新计划 | `steps: [{id,title,status}]` |
| `note` | 记一步的进展与证据 | `step`、`status`(done/failed/blocked/note)、`evidence` |
| `phase` | 切换当前阶段 | `text` |
| `check` | 立刻跑一遍检测器并回未完成步骤 | — |
| `reflect` | 沉淀教训成规则（同文本去重，升版本） | `lesson: "当 X 时做 Y，因为 Z"`、`scope` |
| `rules` | 规则库操作 | `op: list\|mark\|revert`、`ruleId`、`outcome: win\|used`、`version` |
| `plugin` | 创造模式 | `op: new\|validate\|test\|install\|doctor\|rollback\|list`、`name`、`path`、`template: tool\|preset\|bundle` |
| `override` | 清零检测器计数（逃生门，不是解决方案） | `detail` |

结果统一封顶 4 KB；失败返回一句可执行的原因，不吐堆栈。

## 检测器与升级

活动来源是会话本身（`tool/call` 与 `tool/result` 配对，事件流不可用时回落到工具结果事件）。

| 检测器 | 触发 | 建议处置 |
| --- | --- | --- |
| `repeatFailure` | 同一工具连续失败 ≥ `hardBlockAfter` 次 | 换假设、换工具，不要重试同一个调用 |
| `spin` | 最近 10 次里有 ≥3 次**完全相同**的调用签名 | 停下来说清楚为什么不动 |
| `unverifiedWrite` | 写入类工具（`computer_click/type/key/...`、`browser_actions`、`write`、`edit`）之后没有可观测工具回读就继续写 | 先截图/读文件确认 |
| `softFailures` | 零散失败累计 ≥3 | 一次 `reflect` 再继续 |

命中即写入账本、注入纠错块；**同一检测器连续命中 3 次**（`hardBlockAfter`）升级为**硬拦截**：除
`evolve` 之外的工具全部被 `tools.guard` 拒绝，直到显式 `reflect` 或 `override`。防护是可降级的：
guard 签名不匹配时自动退化为提示，绝不让宿主崩。

## 创造模式

`evolve({action:"plugin", ...})` 的固定顺序，每一步失败都停在这一步：

1. **`new`**：在插件工作区（默认 `$DSH_HOME/evolve/workspace`）用 `tool` / `preset` / `bundle` 模板
   生成骨架，自带 `cordis.patch.yml`、`lib/`、`README`。
2. **`validate`**：静态契约校验（manifest 键、patch YAML、exports 指向、locale JSON、client 外形）。
   不通过就一个字节都不动。
3. **`test`**：桩 ctx 里真跑 `apply`（不是 mock 被测代码），抓注册期异常。
4. **`install`**：先快照 profile（`package.json` + `cordis.patch.yml`）→ 到宿主 `pluginManager` 服务
   安装；**拿不到服务就明确回「⚠ 未执行」并给出该调用的 `plugin_manager` 工具参数**，绝不假装成功。
5. **`doctor`**：读 profile 落点做健康检查。
6. **`rollback`**：doctor 不健康或你想要撤销时，从快照恢复并再次体检。

`autoRollback` 打开时，doctor 有 fail 会自动走 6。整个链路**不写 profile 的 node_modules**（本地目录是
link，写进去等于改仓库）。

## 自进化规则库

- 位置：`$DSH_HOME/evolve/rules/<scope>.json`，`scope` 由工作目录哈希，同目录的会话共享。
- 结构：`{ version, updatedAt, rules: [{id, text, evidence, uses, wins, createdAt}], snapshots: [...最后 8 版] }`。
- 注入：新会话把 `maxRules`（默认 8）条按「赢得多、用得少、不太旧」排序后放进 `[EVOLVE 进程]`。
- 回滚：`evolve({action:"rules", op:"revert", version: N})`。
- 合并写盘（临时文件 + rename），并发会话不会写坏。

账本：`$DSH_HOME/evolve/ledgers/<sessionId>.jsonl`，超过 512 KB 自动裁到末 400 行；默认保留 14 天。

## 配置

`cordis.patch.yml` 的 `evolve-ptc-settings` 行，或设置卡片。值都会被夹到合法区间，坏值退回默认。

| 键 | 默认 | 范围 / 说明 |
| --- | --- | --- |
| `environment` | `auto` | `auto\|wsl\|powershell\|zsh\|bash`（v1 只用于提示，不改写官方 shell 行） |
| `wslDistribution` / `shellExecutable` | 空 | 透传给 persona 的执行环境说明 |
| `foregroundSeconds` | `30` | 5–600；前台命令超过就该转后台，persona 与检测器同一口径 |
| `processInjection` | `true` | 每步注入 `[EVOLVE 进程]` |
| `injectionEvery` | `1` | 每 N 步刷新注入文本 |
| `stallSeconds` | `240` | ≥60；阶段原地不动超过它算停滞 |
| `correctiveBlocks` | `true` | 命中检测器时注入纠错块 |
| `hardBlockAfter` | `3` | 2–8；同一检测器连续命中几次升级为硬拦截 |
| `rulesInjection` / `maxRules` | `true` / `8` | 规则注入开关与条数上限 |
| `creationMode` | `true` | 允许 `plugin` 系列操作 |
| `pluginWorkspace` | 空 | 空 = `$DSH_HOME/evolve/workspace` |
| `autoRollback` | `true` | doctor 不健康时自动恢复快照 |
| `ledgerRetentionDays` | `14` | 账本保留天数 |
| `snapshotBeforeInstall` | `true` | 安装前快照 profile |

## 自检

```bash
node scripts/check.mjs      # 或 npm test
```

7 段：manifest 契约 / `cordis.patch.yml` / **真读上游派生预设**（断言 id、order、行完整、persona 契约、
运行时行、创造模式行）/ 状态层与四个检测器正反例 / 客户端外形 / 创造模式端到端（脚手架→校验→试跑）/
运行时冒烟（桩 ctx 真跑，覆盖工具、注入段、检测器升级、硬拦截放行、规则沉淀、开关、命令）。

派生上游默认读宿主文档；在 Electron 之外读不到 asar 时退回 `test/fixtures/*.patch.yml`（副本会过期，
自检会打印来源），也可用 `EVOLVE_PTC_UPSTREAM` / `EVOLVE_PTC_CORDIS` 指定。

## 已知限制

- 客户端改动需要刷新页面；替换已安装版本需要重启应用。
- 预设行运行在 isolate realm，`pluginManager` 服务可能不可见 —— 此时 `install` 会明确降级为「提示模型调用
  `plugin_manager`」，而不是静默失败。
- v1 不改写官方 shell 行（不实现执行器组隔离），`environment` 只是给模型的契约说明。
- 规则按工作目录作用域，跨机器不共享；`reflect` 的文本质量决定规则价值，垃圾进垃圾出。

## 与其它模式的关系

- **深度 PTC（`deep-ptc`）**：本插件的基底与参照。它做工具目录压缩、执行环境映射、创造模式实验台；
  本插件不 import 它的内部模块（只看公开契约），避免上游改动把新模式一起弄坏。
- **OPS (PTC)（`ops-ptc`）**：typed 文件 API + 渐进式 SDK 加载。两者可共存：本插件只用官方 `ptc` 文档派生，
  不注册 `ops_*` 工具，也不抢 `run_code`。
