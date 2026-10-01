import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../packages/core/src/index.js";
import { ScriptedFakeModel, type ScriptStep, type ToolCall, type JsonObject } from "../packages/model/src/index.js";
import { calculatorTool, ToolGateway, ToolRegistry } from "../packages/tools/src/index.js";

const bad: ToolCall = { providerCallId: "bad-call", toolName: "calculator", arguments: { operation: "add", left: "2", right: 3 } };
const good: ToolCall = { providerCallId: "good-call", toolName: "calculator", arguments: { operation: "add", left: 2, right: 3 } };
const final: ScriptStep = { type: "final", text: "synthetic stopped", expectToolResultCallId: "good-call" };

describe("generic Loop with gateway feedback policy", () => {
  it("rejects extremely deep proposals at the protocol boundary before recursion can overflow", async () => {
    let nested: JsonObject = {};
    for (let index = 0; index < 100; index++) nested = { nested };
    const execute = vi.fn(calculatorTool().execute);
    const model = new ScriptedFakeModel([{ type: "raw", value: {
      schemaVersion: 1, kind: "tool_calls", calls: [{ ...good, arguments: nested }]
    } }]);
    const result = await runAgent({ model,
      executeTool: new ToolGateway(new ToolRegistry([{ ...calculatorTool(), execute }])).execute });
    expect(result.reason).toBe("INVALID_RESPONSE");
    expect(execute).not.toHaveBeenCalled();
  });
  it("feeds a structured rejection back, permits correction and charges both attempts", async () => {
    const tool = calculatorTool(); const execute = vi.fn(tool.execute);
    const gateway = new ToolGateway(new ToolRegistry([{ ...tool, execute }]));
    const model = new ScriptedFakeModel([
      { type: "tool_calls", calls: [bad] },
      { type: "tool_calls", calls: [good], expectToolResultCallId: "bad-call" }, final
    ]);
    const result = await runAgent({ runId: "repair", model, executeTool: gateway.execute, toolErrorPolicy: "feedback" });
    expect(result).toMatchObject({ status: "model_stopped", modelTurns: 3, toolCalls: 2 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.requests[1]?.context.at(-1)).toMatchObject({ kind: "tool_result", result: {
      status: "error", error: { code: "VALIDATION_ERROR", outcome: "not_started",
        actionId: "repair.action.1", attemptId: "repair.action.1.attempt.1" }
    } });
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ actionId: "repair.action.2", attemptId: "repair.action.2.attempt.1" });
  });

  it("retains the default stop-on-error behavior", async () => {
    const model = new ScriptedFakeModel([{ type: "tool_calls", calls: [bad] }, final]);
    const result = await runAgent({ model, executeTool: new ToolGateway(new ToolRegistry([calculatorTool()])).execute });
    expect(result).toMatchObject({ status: "failed", reason: "TOOL_FAILURE", modelTurns: 1, toolCalls: 1 });
    expect(model.requests).toHaveLength(1);
  });

  it("cannot loop forever correcting rejected parameters", async () => {
    const tool = calculatorTool(); const execute = vi.fn(tool.execute);
    const model = new ScriptedFakeModel(Array.from({ length: 4 }, (): ScriptStep => ({ type: "tool_calls", calls: [bad] })));
    const result = await runAgent({ model, toolErrorPolicy: "feedback",
      executeTool: new ToolGateway(new ToolRegistry([{ ...tool, execute }])).execute,
      limits: { maxModelTurns: 3, maxToolCalls: 2 } });
    expect(result).toMatchObject({ status: "budget_exhausted", reason: "MAX_TOOL_CALLS", modelTurns: 3, toolCalls: 2 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops on unknown outcomes and never requests a model retry", async () => {
    const execute = vi.fn(() => new Promise<unknown>(() => {}));
    let fire!: () => void;
    let announce!: () => void;
    const entered = new Promise<void>((resolve) => { announce = resolve; });
    const gateway = new ToolGateway(new ToolRegistry([{ ...calculatorTool(), execute: () => { announce(); return execute(); } }]),
      { schedule: (_, callback) => { fire = callback; return () => {}; } });
    const model = new ScriptedFakeModel([{ type: "tool_calls", calls: [good] }, final]);
    const running = runAgent({ model, executeTool: gateway.execute, toolErrorPolicy: "feedback" });
    await entered; fire();
    expect(await running).toMatchObject({ status: "failed", reason: "TOOL_OUTCOME_UNKNOWN", modelTurns: 1, toolCalls: 1 });
    expect(model.requests).toHaveLength(1); expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects forged Action/Attempt association from an executor", async () => {
    const model = new ScriptedFakeModel([{ type: "tool_calls", calls: [bad] }]);
    const gateway = new ToolGateway(new ToolRegistry([calculatorTool()]));
    const result = await runAgent({ runId: "ids", model, executeTool: async (call, control) => {
      const value = await gateway.execute(call, control);
      return { ...value, error: { ...value.error!, attemptId: "forged.attempt.1" } };
    } });
    expect(result.reason).toBe("INVALID_TOOL_RESULT");
  });
});
