import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, win32 } from "node:path";
import type { Stats } from "node:fs";
import { ToolFault } from "./registry.js";

const MAX_FILE_BYTES = 8192;
const denied = (): never => { throw new ToolFault("PATH_NOT_ALLOWED", "not_started"); };
function leaf(name: string): void {
  // Flat namespace: no directory components, drive letters, alternate streams or dot traversal.
  if (isAbsolute(name) || win32.isAbsolute(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    || name.includes("..") || name.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) denied();
}
function identity(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

export class RestrictedWorkspace {
  private constructor(readonly root: string, private readonly rootStat: Stats) {}
  static async configure(root: string): Promise<RestrictedWorkspace> {
    if (!isAbsolute(root)) throw new TypeError("An explicit absolute experiment workspace is required.");
    const stat = await lstat(root);
    const canonical = await realpath(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(root, canonical) !== "") denied();
    return new RestrictedWorkspace(canonical, stat);
  }
  private async checkRoot(): Promise<void> {
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !identity(stat, this.rootStat)
      || relative(this.root, await realpath(this.root)) !== "") denied();
  }
  async checkRead(name: string): Promise<Stats> {
    leaf(name); await this.checkRoot();
    const stat = await lstat(join(this.root, name));
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) denied();
    if (stat.size > MAX_FILE_BYTES) throw new ToolFault("INPUT_LIMIT_EXCEEDED", "not_started");
    return stat;
  }
  async checkWrite(name: string): Promise<void> {
    leaf(name); await this.checkRoot();
    try { await lstat(join(this.root, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    denied(); // New reports only. Existing files, hard links and symlinks are never overwritten.
  }
  async read(name: string, signal: AbortSignal): Promise<string> {
    const before = await this.checkRead(name);
    signal.throwIfAborted();
    const handle = await open(join(this.root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const after = await handle.stat();
      const entry = await lstat(join(this.root, name));
      await this.checkRoot();
      if (!identity(before, after) || !identity(after, entry) || entry.isSymbolicLink() || after.nlink !== 1) denied();
      signal.throwIfAborted();
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new ToolFault("OUTPUT_LIMIT_EXCEEDED", "failed");
      signal.throwIfAborted();
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  }
  async write(name: string, content: string, signal: AbortSignal): Promise<number> {
    await this.checkWrite(name);
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new ToolFault("INPUT_LIMIT_EXCEEDED", "not_started");
    signal.throwIfAborted();
    let handle: FileHandle;
    try { handle = await open(join(this.root, name), "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") denied();
      throw error;
    }
    try {
      // A created/partially written report is a side effect; later failure stays unknown.
      await this.checkRoot();
      signal.throwIfAborted();
      await handle.writeFile(content, { encoding: "utf8", signal });
      return Buffer.byteLength(content, "utf8");
    } catch { throw new ToolFault("EXECUTION_ERROR", "unknown"); }
    finally { await handle.close(); }
  }
}
