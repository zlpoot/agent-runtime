# ADR-001：TypeScript 主内核与循序实验

- 状态：接受（Issue #2 工程决策）
- 日期：2026-09-30
- 依据：[Issue #1](https://github.com/zlpoot/agent-runtime/issues/1)、[Issue #2](https://github.com/zlpoot/agent-runtime/issues/2)

## 背景

项目同时追求可理解的 Agent Runtime 和可重复运行的实验。若一开始接入完整 Agent SDK 或真实模型，Loop、工具提案与执行边界会被隐藏，实验也难以确定性复现。

## 决策

1. 主内核使用 TypeScript strict、Node.js、pnpm workspace 和 Vitest。
2. 自行实现 Loop 与状态转换；基础库可复用，但不引入接管 Loop 的框架。
3. V0.1 先做单 Agent、默认串行工具；先用 Fake Model 和本地实验理解机制，再独立接入真实模型。
4. Python 后置为 Tool/Worker 适配器，不成为第一版运行依赖。
5. 每阶段先预测、再实验、故障注入、解释，人工学习验收与工程检查分开。

## 后果

早期工程能力有意保持有限；#2 的 CLI 不运行 Agent。后续功能必须按 Issue 授权推进，新的架构选择再补 ADR。许可证未在本 ADR 中决定。
