import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../packages/core/src/run-agent.js";
import { createRunState, transitionRun } from "../packages/core/src/run-state.js";
import {
  ManualGate, ScriptedFakeModel,
  type ModelAdapter, type ModelResponse, type RuntimeEvent, type ScriptStep, type ToolCall
} from "../packages/model/src/index.js";
import { executeCalculator } from "../packages/tools/src/calculator.js";

const call = (id: string, left = 2): ToolCall => ({
  providerCallId: id, toolName: "calculator", arguments: { operation: "add", left, right: 3 }
});
const fake = (script: readonly ScriptStep[]) => new ScriptedFakeModel(script);
const final: ScriptStep = { type: "final", text: "model stopped" };
const logical = (events: readonly RuntimeEvent[]) => events.map((event) => {
  const { elapsedMs: _, ...rest } = event;
  if ("durationMs" in rest) {
    const { durationMs: __, ...metadata } = rest;
    return metadata;
  }
  return rest;
});

describe("minimal serial Agent Loop", () => {
  it("feeds complete proposals and correctly associated results into the next model turn", async () => {
    const model = fake([
      { type: "tool_calls", calls: [call("a"), call("b", 4)] },
      { type: "tool_calls", calls: [call("c", 6)], expectToolResultCallId: "b" },
      { type: "final", text: "model stopped", expectToolResultCallId: "c" }
    ]);
    const result = await runAgent({ model, executeTool: executeCalculator, runId: "normal" });
    expect(result).toMatchObject({ status: "model_stopped", reason: "MODEL_STOPPED",
      modelTurns: 3, toolCalls: 3, finalText: "model stopped" });
    expect(model.requests[1]?.context).toEqual([
      { kind: "assistant_tool_calls", calls: [call("a"), call("b", 4)] },
      { kind: "tool_result", result: executeCalculator(call("a")) },
      { kind: "tool_result", result: executeCalculator(call("b", 4)) }
    ]);
    expect(model.requests[2]?.context.slice(-1)).toEqual([
      { kind: "tool_result", result: executeCalculator(call("c", 6)) }
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual(
      result.events.map((_, index) => index + 1)
    );
    expect(result.events.every((event) => event.runId === "normal" && event.schemaVersion === 2)).toBe(true);
    expect(result.events.filter((event) => event.kind === "ToolStarted").map((event) => event.actionId))
      .toEqual(["normal.action.1", "normal.action.2", "normal.action.3"]);
  });

  it("waits for the first tool to settle before starting the second", async () => {
    const started: string[] = [];
    const gate = new ManualGate();
    let announceStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { announceStarted = resolve; });
    const running = runAgent({
      model: fake([{ type: "tool_calls", calls: [call("a"), call("b")] }, final]),
      executeTool: async (proposal) => {
        started.push(proposal.providerCallId);
        if (proposal.providerCallId === "a") {
          announceStarted();
          await gate.wait();
        }
        return executeCalculator(proposal);
      }
    });
    await firstStarted;
    expect(started).toEqual(["a"]);
    gate.release();
    expect((await running).status).toBe("model_stopped");
    expect(started).toEqual(["a", "b"]);
  });

  it("bounds repeated model proposals and assigns fresh Runtime action IDs", async () => {
    const model = fake(Array.from({ length: 4 }, (): ScriptStep => ({
      type: "tool_calls", calls: [call("same-provider-id")]
    })));
    const result = await runAgent({ model, executeTool: executeCalculator, runId: "repeat",
      limits: { maxModelTurns: 3, maxToolCalls: 10 } });
    expect(result).toMatchObject({ status: "budget_exhausted", reason: "MAX_MODEL_TURNS",
      modelTurns: 3, toolCalls: 3 });
    expect(model.requests).toHaveLength(3);
    expect(result.events.filter((event) => event.kind === "ToolStarted").map((event) => event.actionId))
      .toEqual(["repeat.action.1", "repeat.action.2", "repeat.action.3"]);
  });

  it("rejects a batch that exceeds the remaining tool budget before executing any of it", async () => {
    const execute = vi.fn(executeCalculator);
    const result = await runAgent({
      model: fake([{ type: "tool_calls", calls: [call("a"), call("b")] }]),
      executeTool: execute, limits: { maxToolCalls: 1 }
    });
    expect(result).toMatchObject({ status: "budget_exhausted", reason: "MAX_TOOL_CALLS", toolCalls: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.kind === "ToolStarted")).toBe(false);
  });

  it("counts tool calls across turns and still permits final at the exact limits", async () => {
    const model = fake([
      { type: "tool_calls", calls: [call("a")] },
      { type: "tool_calls", calls: [call("b")] }
    ]);
    const limited = await runAgent({ model, executeTool: executeCalculator, limits: { maxToolCalls: 1 } });
    expect(limited).toMatchObject({ reason: "MAX_TOOL_CALLS", toolCalls: 1, modelTurns: 2 });
    const exact = await runAgent({
      model: fake([{ type: "tool_calls", calls: [call("a")] }, final]),
      executeTool: executeCalculator, limits: { maxToolCalls: 1, maxModelTurns: 2 }
    });
    expect(exact.status).toBe("model_stopped");
  });

  it("validates the entire external response before dispatch, even if the first call is valid", async () => {
    const execute = vi.fn(executeCalculator);
    const model: ModelAdapter = {
      capabilities: { toolCalls: true, cancellation: true },
      async generate() {
        return { schemaVersion: 1, kind: "tool_calls", calls: [call("a"), {
          ...call("b"), arguments: "not parsed JSON"
        }] } as unknown as ModelResponse;
      }
    };
    const result = await runAgent({ model, executeTool: execute });
    expect(result).toMatchObject({ status: "failed", reason: "INVALID_RESPONSE", toolCalls: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops on a calculator error without starting later tools or another model turn", async () => {
    const model = fake([{ type: "tool_calls", calls: [
      { ...call("bad"), arguments: { operation: "divide", left: 1, right: 0 } }, call("later")
    ] }, final]);
    const execute = vi.fn(executeCalculator);
    const result = await runAgent({ model, executeTool: execute });
    expect(result).toMatchObject({ status: "failed", reason: "TOOL_FAILURE", toolCalls: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(1);
    expect(result.events.some((event) => event.kind === "ToolFailed")).toBe(true);
  });

  it.each(["mismatch", "invalid", "throw"] as const)("rejects %s tool outcomes without retrying", async (mode) => {
    const execute = vi.fn(() => {
      if (mode === "throw") throw new Error("synthetic exception");
      return mode === "mismatch"
        ? { schemaVersion: 1, providerCallId: "wrong", status: "success", content: 1 }
        : { schemaVersion: 1, providerCallId: "a", status: "success", content: Infinity };
    });
    const result = await runAgent({
      model: fake([{ type: "tool_calls", calls: [call("a")] }]),
      executeTool: execute as unknown as typeof executeCalculator
    });
    expect(result.reason).toBe(mode === "throw" ? "EXECUTOR_FAILURE" : "INVALID_TOOL_RESULT");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["script", "throw"] as const)("surfaces %s model errors without calling tools", async (mode) => {
    const execute = vi.fn(executeCalculator);
    const model: ModelAdapter = mode === "script"
      ? fake([{ type: "error", message: "synthetic failure" }])
      : { capabilities: { toolCalls: true, cancellation: true },
          async generate() { throw new Error("synthetic failure"); } };
    const result = await runAgent({ model, executeTool: execute });
    expect(result).toMatchObject({ status: "failed", reason: "MODEL_FAILURE" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels before the first model request", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = fake([final]);
    const result = await runAgent({ model, executeTool: executeCalculator, signal: controller.signal });
    expect(result).toMatchObject({ status: "cancelled", reason: "ABORTED", modelTurns: 0, toolCalls: 0 });
    expect(model.requests).toHaveLength(0);
  });

  it("cancels a controlled model wait without releasing the gate or dispatching tools", async () => {
    const controller = new AbortController();
    const model = fake([{ type: "wait", gate: new ManualGate(), then: final }]);
    const execute = vi.fn(executeCalculator);
    const running = runAgent({ model, executeTool: execute, signal: controller.signal });
    expect(model.requests).toHaveLength(1);
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ status: "cancelled", reason: "ABORTED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("checks user cancellation between serial tools while retaining a known success", async () => {
    const controller = new AbortController();
    const execute = vi.fn((proposal: ToolCall) => {
      controller.abort();
      return executeCalculator(proposal);
    });
    const result = await runAgent({
      model: fake([{ type: "tool_calls", calls: [call("a"), call("b")] }]),
      executeTool: execute, signal: controller.signal
    });
    expect(result.status).toBe("cancelled");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.events.some((event) => event.kind === "ToolSucceeded")).toBe(true);
  });

  it("recognizes cancellation while a cooperative pure tool is waiting", async () => {
    const controller = new AbortController();
    const gate = new ManualGate();
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const running = runAgent({
      model: fake([{ type: "tool_calls", calls: [call("a")] }]),
      signal: controller.signal,
      executeTool: async (proposal, control) => {
        announceStarted();
        if (!await gate.wait(control.signal)) throw new Error("synthetic abort");
        return executeCalculator(proposal);
      }
    });
    await started;
    controller.abort();
    expect(await running).toMatchObject({ status: "cancelled", reason: "ABORTED", toolCalls: 1 });
  });

  it("produces identical logical events with different controlled clocks", async () => {
    const run = (increment: number) => {
      let tick = 0;
      return runAgent({ runId: "deterministic", executeTool: executeCalculator,
        model: fake([{ type: "tool_calls", calls: [call("a")] }, final]),
        now: () => { tick += increment; return tick; } });
    };
    const first = await run(1);
    const second = await run(7);
    expect(logical(first.events)).toEqual(logical(second.events));
    expect(first.events.filter((event) => "durationMs" in event).every((event) => event.durationMs >= 0)).toBe(true);
  });

  it("omits synthetic secrets from inputs, arguments, IDs, results and final text in trace", async () => {
    const secret = "SYNTHETIC_SECRET_DO_NOT_LOG";
    const result = await runAgent({
      model: fake([{ type: "tool_calls", calls: [{
        providerCallId: secret, toolName: secret, arguments: { payload: secret }
      }] }, { type: "final", text: secret }]),
      context: [{ kind: "user", text: secret }],
      executeTool: () => ({ schemaVersion: 1, providerCallId: secret, status: "success", content: secret })
    });
    expect(result.finalText).toBe(secret);
    expect(JSON.stringify(result.events)).not.toContain(secret);
  });

  it("omits raw model failure messages from the trace", async () => {
    const secret = "SYNTHETIC_FAILURE_SECRET";
    const result = await runAgent({ model: fake([{ type: "error", message: secret }]),
      executeTool: executeCalculator });
    expect(result.reason).toBe("MODEL_FAILURE");
    expect(JSON.stringify(result.events)).not.toContain(secret);
  });

  it("makes state decisions deterministically without mutating the previous state", () => {
    const state = createRunState("pure", [], { maxModelTurns: 1, maxToolCalls: 1 });
    const before = structuredClone(state);
    const first = transitionRun(state, { kind: "advance" });
    expect(first).toEqual(transitionRun(state, { kind: "advance" }));
    expect(state).toEqual(before);
    expect(first.command.kind).toBe("request_model");
    const ended = transitionRun(first.state, { kind: "cancel" });
    expect(transitionRun(ended.state, { kind: "advance" }).events).toEqual([]);
  });

  it.each([Infinity, -1, 1.5, NaN])("rejects invalid runtime limits %s", (limit) => {
    expect(() => createRunState("bad-limit", [], { maxModelTurns: limit, maxToolCalls: 1 })).toThrow(RangeError);
    expect(() => createRunState("bad-limit", [], { maxModelTurns: 1, maxToolCalls: limit })).toThrow(RangeError);
  });
});
