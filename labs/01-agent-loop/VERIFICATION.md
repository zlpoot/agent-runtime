# Issue #5 工程验证记录

- 日期：2026-10-01（客户端日期）
- 基线：#30 已合并，`main` commit `a58edbab870d8f1dcf6ff914bd857cfe6ef2ecf9`。
- 环境：Windows / PowerShell，Node **v22.22.1**，pnpm **10.33.0**。
- 分支：`codex/issue-5-agent-loop-lab`。
- 依赖变化：仅增加 lab 的三个 workspace 链接；无新增外部包，无版本升级。

## 通过

| 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 退出 0，6 个 workspace 项目，无需下载新外部依赖 |
| `pnpm typecheck` | 退出 0，包含新 lab 构建和根测试文件类型检查 |
| `pnpm test` | 退出 0，8 个测试文件 / 100 项测试通过（原 68 + 新 32） |
| `pnpm build` | 退出 0，model/core/tools/CLI/lab 均构建成功 |
| `pnpm lab agent-loop inspect` | 稳定入口退出 0；1 个提案，0 个执行器命令，0 次 calculator 调用 |
| 四种模式的编译后 CLI / JSONL | 全部退出 0；inspect 1、execute 10、break 18、step 13 帧 |
| 三种损坏模式 + tool budget 0 | 全部生成预期终态；故障本身是预期观察，测试检查其原因及调用次数 |
| 单步等待、取消、EOF | 可控 ManualGate 测试；CLI 三个 Enter 正常结束；q / EOF 退出 130；等待中无 calculator 成功事件 |
| JSONL 脱敏 / 顺序 | 实际 8 份 trace 可解析，labSequence 每次运行连续；未含 providerCallId、arguments、原始输入或模型正文；定时函数注入测试可复现 |
| `git diff --check` | 退出 0，无空白错误 |

实际 trace 来自 `node labs/01-agent-loop/dist/main.js agent-loop <mode> --jsonl`，故障加 `--fault <name>`，零工具额度加 `--max-tool-calls 0`。`step` 通过子进程输入三个 Enter 生成；这只验证工程入口，不是用户学习操作。

## 失败

工程检查无失败。以下是预期注入故障，不计为工程验证失败：

| 注入 | 可见结果 | 证据 |
| --- | --- | --- |
| no-dispatch | TOOL_FAILURE；执行器命令 1，calculator 0 | [trace](traces/no-dispatch.jsonl) |
| missing-result | EXPECTED_TOOL_RESULT_MISSING；calculator 1，最后请求结果数 0 | [trace](traces/missing-result.jsonl) |
| wrong-call-id | INVALID_TOOL_RESULT；calculator 1，未发起下一模型轮 | [trace](traces/wrong-call-id.jsonl) |
| infinite | MAX_MODEL_TURNS；3 轮、3 次 calculator；无模型 final / 脚本耗尽 | [trace](traces/break.jsonl) |
| tool budget 0 | MAX_TOOL_CALLS；可见提案、0 次执行 | [trace](traces/tool-budget-zero.jsonl) |

## 未运行 / 未完成

- CI：记录文件写入时 PR 尚未创建；远端结果以关联 PR 的 Checks 和正文验证表为准。既有 workflow 会安装、typecheck、测试和构建新 lab。
- 真实模型/API、凭证、shell、网络工具调用：本 Issue 不实现，未运行。
- 真实终端 Ctrl+C 人工操作：未运行；q、EOF 与受控 AbortSignal 已由测试覆盖。
- kill 后恢复 / 持久化 Pause：当前无恢复协议，未实现也未运行恢复验证。
- 用户预测、运行/观看记录、四个 Explain 回答及同意进入 M1：保留空白模板，未代填；Issue #5 保持打开。

## 决策与范围

复用 [ADR-001](../../docs/adr/001-typescript-kernel.md)、[ADR-002](../../docs/adr/002-explicit-serial-loop.md)。仅新增教学包装，没有改变生产协议、Loop 或状态转换，没有新增架构决策。#6 及后续阶段未开始。
