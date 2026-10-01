# ADR-002：显式状态转换与串行执行边界

- 状态：接受（Issue #4 工程决策）
- 日期：2026-09-30
- 依据：[Issue #4](https://github.com/zlpoot/agent-runtime/issues/4)、[ADR-001](001-typescript-kernel.md)

## 背景

#3 已定义完整响应协议和可控模型替身。#4 需要观察每次模型请求、工具执行、结果回填和停止原因，并确定性地测试预算与取消。

## 决策

1. `transitionRun(state, input)` 纯函数决定新状态、事件草稿与命令；`runAgent` 执行命令并反馈结果。M0 状态驻留内存。
2. 全部响应校验完成后，为提案分配 Runtime Action ID。按数组顺序串行执行；整批工具额度不足时整批不启动。错误立即停止，不自动重试。
3. 请求上下文包含本轮的模型提案消息及按顺序回填的工具结果。执行结果必须与当前提案的 provider call ID 匹配。
4. 运行额度由 Runtime 计数，使用本地 AbortSignal 控制取消。模型 final 对外标记为 `model_stopped`。
5. RuntimeEvent 使用 schemaVersion 2，将 #3 的提案/错误正文改为元数据，并扩展完整 Loop 事件；模型 DTO 保持版本 1。默认 trace 只输出元数据。

## 后果

决策函数可以独立测试，执行入口明确。当前只提供纯 calculator 与合成实验，既有上下文与事件都在内存中。协作式取消不能强制终止不配合的组件；崩溃恢复、执行隔离、真实模型与业务完成验证依赖后续阶段。
