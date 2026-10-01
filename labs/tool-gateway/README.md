# #6 工具网关实验

先阅读 [课文](../../docs/lessons/03-tool-gateway.md)，把自己的预测记在下表，再运行。模型都是 Fake；文件均为合成资料，实验产物留在你显式选择的目录。

## 环境与入口

Node 22.22.1、pnpm 10.33.0、Ajv 8.20.0。根目录执行：

```powershell
pnpm install --frozen-lockfile
New-Item -ItemType Directory -Force labs/workspaces/gateway | Out-Null
$gatewayWorkspace = (Resolve-Path labs/workspaces/gateway).Path
pnpm lab:tool-gateway --workspace $gatewayWorkspace --scenario normal
pnpm lab:tool-gateway --workspace $gatewayWorkspace --scenario repair
pnpm lab:tool-gateway --workspace $gatewayWorkspace --scenario faults
pnpm lab:tool-gateway --workspace $gatewayWorkspace --scenario unknown
```

每次创建一个 `gateway-lab-*` 子目录，其中 allowed 存资料和报告、outside 存合成边界标记。不会访问真实敏感目录。默认输出 JSON 元数据，stderr 提示实验路径；加 `--jsonl` 隐去路径提示。要得到没有 pnpm 构建日志的 JSONL：

```powershell
node apps/cli/dist/gateway-lab.js --workspace $gatewayWorkspace --scenario normal --jsonl
```

预期注入故障和 unknown 实验退出 0；查看结构化终态，不能以退出码判断业务完成。参数或实验基础设施失败退出 1。工程测试入口：`pnpm typecheck`、`pnpm test`、`pnpm build`。

## 当前工具契约

每个工具均版本 1.0.0、timeout 1000ms、cooperative cancellation；所有对象 Schema 拒绝额外字段。

| 名称 | 输入 | 输出 | effects / resources |
| --- | --- | --- | --- |
| calculator | operation 为四则运算之一，left/right 为有限 number | value: number | pure / [] |
| read_fixture | path 为工作区内单一文件名 | text: string | read_workspace / [workspace] |
| write_report | path 为新的单一文件名，text: string | bytesWritten: integer | write_workspace / [workspace] |

输入/输出 JSON content 默认最多 16KiB、嵌套深度 8（根为 0）；文件最多 8192 UTF-8 bytes。输出字符串最多保留 1024 字符并追加 `[TRUNCATED]`，再检验 Schema。异常原文完全丢弃，错误消息固定且不超过 240 字符。错误 envelope 也受协议字段长度约束。敏感键、Bearer / token 等模式和显式配置 secrets 被替换；这是有限脱敏规则，不能宣称发现所有可能的未知秘密。默认 trace 始终不输出原始参数、结果正文和异常。

文件名只支持平面 ASCII namespace，不支持子目录、`..`、绝对路径、Windows drive/UNC/ADS、保留设备名或尾随点。根目录不得经 symlink/junction 解析；读取拒绝 symlink/junction 和硬链接，写入仅 wx 新建、禁止覆盖。私有实验目录须由可信单一所有者管理；检查与 open 之间不能隔离恶意并发父目录替换。这是受限工具，**不是 OS sandbox 或审批系统**。

## 先预测再观察（用户填写）

| 实验 | 用户预测 | 用户实际观察 | 用户解释 |
| --- | --- | --- | --- |
| normal | | | |
| repair：错误参数后修正 | | | |
| faults：未知工具 / 缺字段 / 类型 / 多余字段 / 超大输入 | | | |
| faults：异常结果 / 工具抛错 | | | |
| faults：../ / 绝对路径 / symlink 或 junction | | | |
| unknown：超时后仍发生合成计数变化 | | | |

## 工程参考与 trace

下面是工程预期，不是用户学习记录：

| 场景 | Runtime / 工具观察 | trace |
| --- | --- | --- |
| normal | 2 个模型轮次 / 3 个命令 / 3 次实际实现；报告仅在 allowed 新建 | [normal](traces/normal.jsonl) |
| repair | 3 个模型轮次 / 2 个命令 / 1 次实际实现；1 个参数拒绝回填 | [repair](traces/repair.jsonl) |
| faults | 12 个请求，10 个执行前拒绝，只有异常结果/抛错两个实现启动；outside 不变 | [faults](traces/faults.jsonl) |
| unknown | 1 轮 / 1 次实现，TIMEOUT / unknown；Loop 为 TOOL_OUTCOME_UNKNOWN，随后合成 lateSyntheticEffects=1 | [unknown](traces/unknown.jsonl) |

unknown 实验用受控截止回调和 ManualGate，模拟不配合取消的实现；不使用 sleep 猜时序，晚到的“效果”只是内存计数，不是真实外部写入。实际超时后的 in-flight gateway 返回 BUSY，直到实现真正结束；仍不能推断结果或自动重试。

GatewayEvent 版本 1，RuntimeEvent 版本 2，GatewayLabObservation 版本 1。labSequence 排列全部帧；Runtime sequence 单独排列 Runtime 事件。Action / Attempt 来自 Runtime。实验报告或 JSONL 都没有自动恢复入口。

## Explain（由用户回答）

- 为什么 TS 类型不能验证模型传来的 JSON？
- 工具元数据为什么不能被模型改写？
- 参数检查通过是否意味着已授权、已隔离或执行一定成功？

工程验证见 [VERIFICATION.md](VERIFICATION.md)。本 Issue 不接入真实模型，不推进 #7。
