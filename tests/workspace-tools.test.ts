import { mkdtemp, writeFile, readFile, symlink, link, mkdir, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculatorTool, ToolGateway, ToolRegistry, workspaceTools } from "../packages/tools/src/index.js";

const ids = { actionId: "files.action.1", attemptId: "files.action.1.attempt.1" };
const roots: string[] = [];
async function fixture() {
  const parent = resolve("labs/workspaces");
  await mkdir(parent, { recursive: true });
  const parentRoot = await mkdtemp(join(parent, "gateway-test-")); roots.push(parentRoot);
  const root = join(parentRoot, "allowed"); const outside = join(parentRoot, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(join(root, "fixture.txt"), "synthetic-only");
  await writeFile(join(outside, "secret.txt"), "synthetic-outside-marker");
  const tools = await workspaceTools(root);
  const executes = tools.map((tool) => vi.fn(tool.execute));
  const gateway = new ToolGateway(new ToolRegistry([calculatorTool(), ...tools.map((tool, index) => ({
    ...tool, execute: executes[index]!
  }))]));
  const invoke = (toolName: string, args: Record<string, string>) => gateway.invoke({ providerCallId: "files-1", toolName, arguments: args }, ids);
  return { root, outside, gateway, executes, invoke };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(resolve("labs/workspaces") + "\\") && !root.startsWith(resolve("labs/workspaces") + "/")) {
      throw new Error("Refusing cleanup outside synthetic workspace.");
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("explicit restricted synthetic file tools", () => {
  it("reads fixtures and creates a new report inside the configured workspace", async () => {
    const { root, invoke, executes } = await fixture();
    expect(await invoke("read_fixture", { path: "fixture.txt" })).toMatchObject({ status: "success", content: { text: "synthetic-only" } });
    expect(await invoke("write_report", { path: "report.md", text: "Synthetic report." }))
      .toMatchObject({ status: "success", content: { bytesWritten: 17 } });
    expect(await readFile(join(root, "report.md"), "utf8")).toBe("Synthetic report.");
    expect(executes.every((execute) => execute.mock.calls.length === 1)).toBe(true);
  });

  it.each(["../secret.txt", "..\\secret.txt", "/absolute.txt", "C:\\outside.txt", "C:relative.txt",
    "\\\\server\\share.txt", "file.txt:stream", "nested/file.txt", "CON.txt", "trailing.", ".", ".."])
    ("rejects %s with zero implementation calls and no external writes", async (path) => {
      const { outside, invoke, executes } = await fixture();
      expect((await invoke("read_fixture", { path })).error).toMatchObject({ code: "PATH_NOT_ALLOWED", outcome: "not_started" });
      expect((await invoke("write_report", { path, text: "synthetic overwrite attempt" })).error)
        .toMatchObject({ code: "PATH_NOT_ALLOWED", outcome: "not_started" });
      expect(executes.every((execute) => execute.mock.calls.length === 0)).toBe(true);
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("synthetic-outside-marker");
      expect(await readdir(outside)).toEqual(["secret.txt"]);
    });

  it("rejects symlink/junction escape and nested components before implementation", async () => {
    const { root, outside, invoke, executes } = await fixture();
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    for (const path of ["escape", "escape/secret.txt", "escape\\secret.txt"]) {
      expect((await invoke("read_fixture", { path })).error?.code).toBe("PATH_NOT_ALLOWED");
      expect((await invoke("write_report", { path, text: "synthetic" })).error?.code).toBe("PATH_NOT_ALLOWED");
    }
    expect(executes.every((execute) => execute.mock.calls.length === 0)).toBe(true);
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  it("rejects a hard-linked external fixture and existing report without overwrite", async () => {
    const { root, outside, invoke, executes } = await fixture();
    await link(join(outside, "secret.txt"), join(root, "linked.txt"));
    expect((await invoke("read_fixture", { path: "linked.txt" })).error?.code).toBe("PATH_NOT_ALLOWED");
    expect((await invoke("write_report", { path: "fixture.txt", text: "overwrite" })).error?.code).toBe("PATH_NOT_ALLOWED");
    expect(executes.every((execute) => execute.mock.calls.length === 0)).toBe(true);
    expect(await readFile(join(root, "fixture.txt"), "utf8")).toBe("synthetic-only");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("synthetic-outside-marker");
  });

  it("requires an explicit absolute real directory rather than a symlink root", async () => {
    const { root, outside } = await fixture();
    await expect(workspaceTools("relative-root")).rejects.toThrow();
    await symlink(outside, join(root, "root-link"), process.platform === "win32" ? "junction" : "dir");
    await expect(workspaceTools(join(root, "root-link"))).rejects.toThrow();
  });

  it("rejects oversized files and byte-heavy reports before calculator/file implementations", async () => {
    const { root, invoke, executes } = await fixture();
    await writeFile(join(root, "large.txt"), "x".repeat(8193));
    expect((await invoke("read_fixture", { path: "large.txt" })).error?.code).toBe("INPUT_LIMIT_EXCEEDED");
    expect((await invoke("write_report", { path: "bytes.md", text: "汉".repeat(3000) })).error?.code)
      .toBe("INPUT_LIMIT_EXCEEDED");
    // JSON byte bound catches a report exceeding the gateway input limit.
    expect((await invoke("write_report", { path: "large.md", text: "汉".repeat(8192) })).error?.code)
      .toBe("INPUT_LIMIT_EXCEEDED");
    expect(executes.every((execute) => execute.mock.calls.length === 0)).toBe(true);
  });
});
