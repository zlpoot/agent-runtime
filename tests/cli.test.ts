import { describe, expect, it } from "vitest";
import { resolveCliArgs } from "../apps/cli/src/index.js";

describe("CLI entry", () => {
  it("describes the synthetic demo without credentials", () => {
    const result = resolveCliArgs(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("does not contact a real model");
    expect(result.message).toContain("Usage: node apps/cli/dist/main.js --help");
  });

  it("rejects unknown commands before any runtime action", () => {
    const result = resolveCliArgs(["run"]);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("Unknown command");
    expect(result.message).toContain("node apps/cli/dist/main.js --help");
  });
});
