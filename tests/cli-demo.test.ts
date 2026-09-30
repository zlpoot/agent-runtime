import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCliArgs } from "../apps/cli/src/index.js";
import type { RuntimeEvent } from "../packages/model/src/index.js";

const cli = fileURLToPath(new URL("../apps/cli/dist/main.js", import.meta.url));
function run(scenario: string) {
  const child = spawnSync(process.execPath, [cli, "demo", "--scenario", scenario, "--jsonl"], {
    encoding: "utf8", timeout: 3000
  });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  const events = child.stdout.trim().split("\n").map((line) => JSON.parse(line) as RuntimeEvent);
  expect(events.every((event) => event.schemaVersion === 2 && typeof event.kind === "string")).toBe(true);
  return { code: child.status, events, ended: events.at(-1) };
}

describe("built CLI demo", () => {
  it("prints a complete multi-turn JSONL trace from installed workspace packages", () => {
    const { code, events, ended } = run("normal");
    expect(code).toBe(0);
    expect(ended).toMatchObject({ kind: "RunEnded", status: "model_stopped", modelTurns: 3, toolCalls: 3 });
    expect(events.filter((event) => event.kind === "ToolSucceeded")).toHaveLength(3);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(JSON.stringify(events)).not.toContain("arguments");
    expect(JSON.stringify(events)).not.toContain("Synthetic calculator exercise");
  });

  it.each([
    ["budget", 3, "budget_exhausted", "MAX_TOOL_CALLS"],
    ["repeat", 3, "budget_exhausted", "MAX_MODEL_TURNS"],
    ["tool-error", 1, "failed", "TOOL_FAILURE"],
    ["model-error", 1, "failed", "MODEL_FAILURE"],
    ["cancel", 130, "cancelled", "ABORTED"]
  ])("makes %s visible with its own outcome and exit code", (scenario, expectedCode, status, reason) => {
    const { code, ended } = run(String(scenario));
    expect(code).toBe(expectedCode);
    expect(ended).toMatchObject({ kind: "RunEnded", status, reason });
  });

  it.each([
    ["demo", "--max-model-turns", "Infinity"],
    ["demo", "--max-model-turns", "0"],
    ["demo", "--max-tool-calls", "1.5"],
    ["demo", "--scenario", "shell"],
    ["demo", "--jsonl", "--jsonl"],
    ["demo", "--scenario"]
  ])("rejects invalid CLI options before a Run starts", (...args) => {
    expect(resolveCliArgs(args)).toMatchObject({ exitCode: 2 });
  });
});
