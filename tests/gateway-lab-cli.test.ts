import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../apps/cli/dist/gateway-lab.js", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root, "..").toLowerCase() !== resolve("labs/workspaces").toLowerCase()) throw new Error("Unsafe test cleanup.");
    await rm(root, { recursive: true, force: true });
  }
});
describe("compiled gateway lab", () => {
  it.each([
    ["normal", 3, 0, "MODEL_STOPPED"], ["repair", 1, 1, "MODEL_STOPPED"],
    ["faults", 2, 10, undefined], ["unknown", 1, 0, "TOOL_OUTCOME_UNKNOWN"]
  ])("runs %s with sanitized evidence and synthetic-only side effects", async (scenario, calls, rejections, reason) => {
    await mkdir(resolve("labs/workspaces"), { recursive: true });
    const root = await mkdtemp(join(resolve("labs/workspaces"), "gateway-cli-test-")); roots.push(root);
    const child = spawnSync(process.execPath, [cli, "--workspace", root, "--scenario", scenario, "--jsonl"], {
      encoding: "utf8", timeout: 5000
    });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
    const frames = child.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames.map((frame) => frame.labSequence)).toEqual(frames.map((_, index) => index + 1));
    expect(frames.at(-1)).toMatchObject({ kind: "GatewayLabObservation", implementationCalls: calls, rejections });
    if (reason !== undefined) expect(frames.at(-1)?.reason).toBe(reason);
    for (const raw of ["synthetic-only-secret", "arguments", "providerCallId", "password=", root]) {
      expect(child.stdout).not.toContain(raw);
    }
    const experiment = join(root, (await readdir(root))[0]!);
    expect(await readFile(join(experiment, "outside", "marker.txt"), "utf8")).toBe("Synthetic external marker.");
    expect(await readdir(join(experiment, "outside"))).toEqual(["marker.txt"]);
    if (scenario === "normal") expect(await readFile(join(experiment, "allowed", "report.md"), "utf8"))
      .toBe("Synthetic experiment report.");
    if (scenario === "unknown") {
      expect(frames.at(-1)?.lateSyntheticEffects).toBe(1);
      expect(frames.some((frame) => frame.kind === "GatewaySucceeded")).toBe(false);
    }
  });

  it.each([["--workspace", "relative"], ["--scenario", "normal"], ["--workspace"], ["--workspace", "relative", "--jsonl", "--jsonl"]])
    ("rejects incomplete/invalid user configuration before setup writes", (...args) => {
      const child = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 3000 });
      expect(child.status).toBe(1); expect(child.stdout).toBe("");
      expect(child.stderr).not.toContain("relative");
    });
});
