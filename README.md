# Agent Runtime Lab

一个用于理解并实验 Agent Runtime 机制的 TypeScript 项目。当前只完成 [Issue #2](https://github.com/zlpoot/agent-runtime/issues/2) 的工程骨架；CLI 仅说明状态，不会连接模型或执行工具。

## 目标

- **工程目标：**逐阶段实现可理解、可测试的单 Agent 内核，保留可重复运行的实验与验证证据。
- **学习目标：**通过预测、观察、故障注入、恢复和复述，解释模型提案、Runtime 决策、工具执行与验收的边界。

总路线、术语和阶段出口以 [Issue #1](https://github.com/zlpoot/agent-runtime/issues/1) 为准。每次只处理已授权的 Issue；工程检查通过不等于人工学习验收通过。

## 环境与命令

固定环境为 Node.js **22.22.1**（`.node-version` 与 `engines.node`）和 pnpm **10.33.0**（`packageManager`）。先切换到该 Node 版本；CI 从 `.node-version` 读取同一个值。pnpm workspace 会检查 Node 与 pnpm 版本，版本不匹配时应先切换，再安装依赖。`pnpm-lock.yaml` 固定依赖解析结果。

```sh
node --version                 # v22.22.1
pnpm --version                # 10.33.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node apps/cli/dist/main.js --help
```

默认测试只检查本地纯函数，不读取密钥、不请求模型 API、不产生模型费用。`.env.example` 没有真实配置值。本阶段不需要 `.env`。

## 目录

| 路径 | 作用 |
| --- | --- |
| `apps/cli` | 当前只有状态说明入口；控制面在后续 Issue 实现 |
| `packages/core` | 预留自研 Loop 与状态转换代码的位置 |
| `packages/model` | 预留 Fake Model 与后续模型适配器的位置 |
| `packages/tools` | 预留工具契约与派发代码的位置 |
| `labs` | 可重复运行的实验说明、预期故障与脱敏证据 |
| `docs/lessons` | 学习问题、实验解释和待用户填写的学习验收 |
| `docs/adr` | 只记录真实架构决策；现有 ADR-001 |

## 阶段索引

| 阶段 | Issue | 主题 |
| --- | --- | --- |
| M0 | #2–#5 | 工程骨架、最小协议、Fake Model、串行 Loop、人工学习验收 |
| M1–M4 | #6–#14 | 工具、真实模型、长任务、sandbox、审批 |
| M5–M8 | #15–#24 | 恢复、副作用对账、上下文、控制面与完成验收 |
| 集成与 V0.1 | #25–#27 | 独立集成和综合验收 |

详细顺序以 Issue #1 为准。下一项 #3 不由本 PR 自动开始。

## V0.1 范围边界

计划中的 V0.1 为单 Agent、默认串行工具、一个执行环境一个操作所有者。多 Agent、分布式 Worker、RAG、向量记忆、可视化画布、插件市场、自主 Skill 学习和真实桌面接管均不在范围内。Python 后置为适配器，不是第一版运行依赖。真实模型接入也不属于 #2。

仓库尚未选择开源许可证；不要推断已有授权条款。
