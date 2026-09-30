import { describe, expect, it } from "vitest";
import { resolveCliArgs } from "../apps/cli/src/index.js";

describe("Issue #2 CLI scaffold", () => {
  it("describes the unavailable runtime without credentials", () => {
    const result = resolveCliArgs(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("does not contact a model");
  });

  it("rejects unknown commands before any runtime action", () => {
    const result = resolveCliArgs(["run"]);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("Unknown command");
  });
});
