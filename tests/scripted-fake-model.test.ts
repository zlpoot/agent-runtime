import { describe, expect, it } from "vitest";
import {
  ManualGate,
  ScriptedFakeModel
} from "../packages/model/src/scripted-fake-model.js";
import { SCHEMA_VERSION, type ModelRequest } from "../packages/model/src/protocol.js";

const request = (context: ModelRequest["context"] = []): ModelRequest => ({
  schemaVersion: SCHEMA_VERSION,
  runId: "run-1",
  modelTurnId: "turn-1",
  context
});

describe("ScriptedFakeModel", () => {
  it("returns proposals in order and captures an immutable request snapshot", async () => {
    const fake = new ScriptedFakeModel([
      { type: "tool_calls", calls: [
        { providerCallId: "call-1", toolName: "demo.inspect", arguments: { item: "sample" } },
        { providerCallId: "call-2", toolName: "demo.inspect", arguments: { item: "second" } }
      ] }
    ]);
    const response = await fake.generate(request([{ kind: "user", text: "safe input" }]));
    expect(response.kind).toBe("tool_calls");
    if (response.kind === "tool_calls") {
      expect(response.calls.map((call) => call.providerCallId)).toEqual(["call-1", "call-2"]);
    }
    expect(fake.requests[0]?.context).toEqual([{ kind: "user", text: "safe input" }]);
    expect(fake.remainingSteps).toBe(0);
  });

  it("requires the correlated tool result before the next scripted turn", async () => {
    const fake = new ScriptedFakeModel([
      { type: "final", text: "done", expectToolResultCallId: "call-1" },
      { type: "final", text: "done", expectToolResultCallId: "call-1" }
    ]);
    expect(await fake.generate(request())).toMatchObject({
      kind: "error", error: { code: "EXPECTED_TOOL_RESULT_MISSING" }
    });
    expect(await fake.generate(request([{ kind: "tool_result", result: {
      schemaVersion: 1, providerCallId: "call-1", status: "success", content: { value: "ok" }
    } }]))).toEqual({ schemaVersion: 1, kind: "final", text: "done" });
  });

  it("surfaces deterministic model failure and script exhaustion", async () => {
    const fake = new ScriptedFakeModel([{ type: "error", message: "synthetic failure" }]);
    expect(await fake.generate(request())).toMatchObject({
      kind: "error", error: { code: "MODEL_FAILURE", runId: "run-1" }
    });
    expect(await fake.generate(request())).toMatchObject({
      kind: "error", error: { code: "SCRIPT_EXHAUSTED", runId: "run-1" }
    });
  });

  it("rejects an invalid request without consuming a scripted response", async () => {
    const fake = new ScriptedFakeModel([{ type: "final", text: "ready" }]);
    expect(await fake.generate({ ...request(), schemaVersion: 99 } as unknown as ModelRequest)).toMatchObject({
      kind: "error", error: { code: "INVALID_REQUEST" }
    });
    expect(fake.remainingSteps).toBe(1);
    expect(await fake.generate(request())).toMatchObject({ kind: "final", text: "ready" });
  });

  it.each([
    null,
    { schemaVersion: 1, kind: "unknown" },
    { schemaVersion: 1, kind: "final", text: "" },
    { schemaVersion: 1, kind: "tool_calls", calls: [{ providerCallId: "a", toolName: "demo", arguments: [] }] },
    { schemaVersion: 1, kind: "tool_calls", calls: [
      { providerCallId: "a", toolName: "demo", arguments: {} },
      { providerCallId: "a", toolName: "demo", arguments: {} }
    ] }
  ])("turns malformed scripted output into a typed error", async (value) => {
    const fake = new ScriptedFakeModel([{ type: "raw", value }]);
    expect(await fake.generate(request())).toMatchObject({
      kind: "error", error: { code: "INVALID_RESPONSE", runId: "run-1" }
    });
  });

  it("waits for explicit release and supports cancellation", async () => {
    const gate = new ManualGate();
    const fake = new ScriptedFakeModel([{ type: "wait", gate, then: { type: "final", text: "released" } }]);
    let settled = false;
    const pending = fake.generate(request()).then((response) => { settled = true; return response; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.release();
    expect(await pending).toEqual({ schemaVersion: 1, kind: "final", text: "released" });

    const controller = new AbortController();
    const blocked = new ScriptedFakeModel([{
      type: "wait", gate: new ManualGate(), then: { type: "final", text: "never" }
    }]);
    const aborted = blocked.generate(request(), { signal: controller.signal });
    controller.abort();
    expect(await aborted).toMatchObject({ kind: "error", error: { code: "ABORTED" } });
  });
});
