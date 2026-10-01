import { describe, expect, it } from "vitest";
import { EndlessProposalModel, runLab, type LabTraceEvent } from "../labs/01-agent-loop/src/engine.js";
import { ManualGate, SCHEMA_VERSION } from "../packages/model/src/index.js";

describe("M0 Agent Loop teaching experiment", () => {
  it("inspects a real Fake proposal without invoking the Runtime executor", async () => {
    const result = await runLab({ mode: "inspect" });
    expect(result.observation).toMatchObject({ status: "proposal_only", proposedToolCalls: 1,
      calculatorExecutions: 0, toolCommands: 0, modelTurns: 1, lastModelToolResults: 0 });
    expect(result.events.map((event) => event.kind)).toEqual(["LabObservation"]);
  });

  it("executes the same proposal and feeds a correlated result into the next turn", async () => {
    const result = await runLab({ mode: "execute" });
    expect(result.observation).toMatchObject({ status: "model_stopped", reason: "MODEL_STOPPED",
      modelTurns: 2, toolCommands: 1, calculatorExecutions: 1, lastModelToolResults: 1 });
    expect(result.events.map((event) => event.kind)).toEqual([
      "RunStarted", "ModelRequested", "ModelResponded", "ToolProposed", "ToolStarted",
      "ToolSucceeded", "ModelRequested", "ModelResponded", "RunEnded", "LabObservation"
    ]);
  });

  it("bounds an unbounded proposal source at the Runtime model budget", async () => {
    const result = await runLab({ mode: "break" });
    expect(result.observation).toMatchObject({ fault: "infinite", faultLayer: "scheduling",
      status: "budget_exhausted", reason: "MAX_MODEL_TURNS", modelTurns: 3, calculatorExecutions: 3 });
    expect(result.events.filter((event) => event.kind === "ModelRequested")).toHaveLength(3);
    const source = new EndlessProposalModel();
    for (let index = 1; index <= 5; index++) {
      const response = await source.generate({ schemaVersion: SCHEMA_VERSION, runId: "unbounded",
        modelTurnId: `turn-${index}`, context: [] });
      expect(response.kind).toBe("tool_calls");
    }
    expect(source.requests).toHaveLength(5);
  });

  it("rejects execution at the tool budget while still recording the proposal", async () => {
    const result = await runLab({ mode: "break", limits: { maxToolCalls: 0 } });
    expect(result.observation).toMatchObject({ reason: "MAX_TOOL_CALLS", modelTurns: 1,
      proposedToolCalls: 1, toolCommands: 0, calculatorExecutions: 0 });
    expect(result.events.some((event) => event.kind === "ToolStarted")).toBe(false);
  });

  it.each([
    ["no-dispatch", "execution", "TOOL_FAILURE", 1, 0, 0],
    ["missing-result", "protocol", "EXPECTED_TOOL_RESULT_MISSING", 2, 1, 0],
    ["wrong-call-id", "protocol", "INVALID_TOOL_RESULT", 1, 1, 0]
  ] as const)("locates %s at its injected boundary", async (fault, layer, reason, turns, executions, feedback) => {
    const result = await runLab({ mode: "break", fault });
    expect(result.observation).toMatchObject({ status: "failed", reason, faultLayer: layer,
      modelTurns: turns, toolCommands: 1, calculatorExecutions: executions, lastModelToolResults: feedback });
    expect(result.events.filter((event) => event.kind === "ToolStarted")).toHaveLength(1);
    expect(result.events.filter((event) => event.kind === "ModelRequested")).toHaveLength(turns);
  });

  it("pauses before each response and actual calculation using controlled gates", async () => {
    const gates = [new ManualGate(), new ManualGate(), new ManualGate()];
    const entered = gates.map(() => {
      let announce!: () => void;
      const promise = new Promise<void>((resolve) => { announce = resolve; });
      return { announce, promise };
    });
    const events: LabTraceEvent[] = [];
    const running = runLab({ mode: "step", onEvent: (event) => events.push(event),
      advance(checkpoint, signal) {
        entered[checkpoint.ordinal - 1]!.announce();
        return gates[checkpoint.ordinal - 1]!.wait(signal);
      }
    });
    await entered[0]!.promise;
    expect(events.at(-1)).toMatchObject({ kind: "TeachingPause", stage: "before_model_response" });
    expect(events.some((event) => event.kind === "ModelResponded")).toBe(false);
    gates[0]!.release();
    await entered[1]!.promise;
    expect(events.at(-1)).toMatchObject({ kind: "TeachingPause", stage: "before_calculator" });
    expect(events.some((event) => event.kind === "ToolSucceeded")).toBe(false);
    gates[1]!.release();
    await entered[2]!.promise;
    expect(events.filter((event) => event.kind === "ModelResponded")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "ToolSucceeded")).toHaveLength(1);
    gates[2]!.release();
    expect((await running).observation).toMatchObject({ status: "model_stopped", calculatorExecutions: 1 });
    expect(events.filter((event) => event.kind === "TeachingPause").map((event) => event.ordinal))
      .toEqual([1, 2, 3]);
  });

  it("lets independent teaching input cancel before the calculator runs", async () => {
    const result = await runLab({ mode: "step", advance: (checkpoint) => checkpoint.ordinal !== 2 });
    expect(result.observation).toMatchObject({ status: "cancelled", reason: "ABORTED",
      calculatorExecutions: 0, toolCommands: 1 });
    expect(result.events.some((event) => event.kind === "ToolSucceeded")).toBe(false);
  });

  it("produces deterministic, ordered metadata without raw model or tool content", async () => {
    const first = await runLab({ mode: "execute", now: () => 0 });
    const second = await runLab({ mode: "execute", now: () => 0 });
    expect(first.events).toEqual(second.events);
    expect(first.events.map((event) => event.labSequence)).toEqual(first.events.map((_, index) => index + 1));
    const serialized = JSON.stringify(first.events);
    for (const excluded of ["arguments", "providerCallId", "content", "Synthetic lesson input", "Synthetic model stopped"]) {
      expect(serialized).not.toContain(excluded);
    }
    expect(first.events.filter((event) => event.kind !== "LabObservation").every((event) => event.schemaVersion === 2))
      .toBe(true);
  });

  it("requires an independent step input and confines faults to break mode", async () => {
    await expect(runLab({ mode: "step" })).rejects.toThrow("independent advance");
    await expect(runLab({ mode: "execute", fault: "no-dispatch" })).rejects.toThrow("break mode");
  });
});
