import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../labs/01-agent-loop/src/cli.js";
import type { LabTraceEvent } from "../labs/01-agent-loop/src/engine.js";

const cli = fileURLToPath(new URL("../labs/01-agent-loop/dist/main.js", import.meta.url));
function run(args: readonly string[], input?: string) {
  const child = spawnSync(process.execPath, [cli, "agent-loop", ...args, "--jsonl"], {
    encoding: "utf8", timeout: 3000, ...(input === undefined ? {} : { input })
  });
  expect(child.error).toBeUndefined();
  const events = child.stdout.trim().split("\n").map((line) => JSON.parse(line) as LabTraceEvent);
  return { child, events, observation: events.at(-1) };
}

describe("built Agent Loop lab CLI", () => {
  it.each([
    ["inspect", "proposal_only", "PROPOSAL_ONLY"],
    ["execute", "model_stopped", "MODEL_STOPPED"],
    ["break", "budget_exhausted", "MAX_MODEL_TURNS"]
  ])("runs %s through the documented entry", (mode, status, reason) => {
    const { child, events, observation } = run([mode]);
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(observation).toMatchObject({ kind: "LabObservation", status, reason });
    expect(events.map((event) => event.labSequence)).toEqual(events.map((_, index) => index + 1));
  });

  it.each([
    ["no-dispatch", "TOOL_FAILURE"], ["missing-result", "EXPECTED_TOOL_RESULT_MISSING"],
    ["wrong-call-id", "INVALID_TOOL_RESULT"]
  ])("reports the expected %s fault without treating the experiment as a CLI failure", (fault, reason) => {
    const { child, observation } = run(["break", "--fault", fault]);
    expect(child.status).toBe(0);
    expect(observation).toMatchObject({ status: "failed", reason });
  });

  it("queues three piped Enter inputs and keeps step prompts off JSONL stdout", () => {
    const { child, events, observation } = run(["step"], "\n\n\n");
    expect(child.status).toBe(0);
    expect(child.stderr).toContain("[step 3:");
    expect(events.filter((event) => event.kind === "TeachingPause")).toHaveLength(3);
    expect(observation).toMatchObject({ status: "model_stopped", calculatorExecutions: 1 });
  });

  it.each(["q\n", "", "\nq\n"])("makes cancellation/EOF visible without calculating", (input) => {
    const { child, observation } = run(["step"], input);
    expect(child.status).toBe(130);
    expect(observation).toMatchObject({ status: "cancelled", calculatorExecutions: 0 });
  });

  it.each([
    ["agent-loop", "unknown"], ["agent-loop", "execute", "--fault", "no-dispatch"],
    ["agent-loop", "break", "--fault", "shell"], ["agent-loop", "execute", "--jsonl", "--jsonl"],
    ["agent-loop", "break", "--max-model-turns", "0"],
    ["agent-loop", "break", "--max-model-turns", "Infinity"],
    ["agent-loop", "break", "--max-tool-calls", "-1"],
    ["agent-loop", "break", "--max-tool-calls", "1.5"],
    ["agent-loop", "break", "--max-tool-calls", "9007199254740992"],
    ["agent-loop", "break", "--max-tool-calls"]
  ])("rejects invalid arguments before execution", (...args) => {
    expect(() => parseArgs(args)).toThrow(TypeError);
  });

  it("shows help and admits a zero tool budget", () => {
    expect(parseArgs(["--help"])).toBe("help");
    expect(parseArgs(["agent-loop", "break", "--max-tool-calls", "0"]))
      .toMatchObject({ limits: { maxToolCalls: 0 } });
  });
});
