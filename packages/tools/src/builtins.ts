import type { JsonObject } from "@agent-runtime/model";
import { executeCalculator } from "./calculator.js";
import { ToolFault, type RegisteredTool, type ToolDefinition } from "./registry.js";
import { RestrictedWorkspace } from "./workspace.js";

const schema = (properties: JsonObject): JsonObject => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });
const metadata = { version: "1.0.0", timeoutMs: 1000, cancellation: "cooperative" as const };
const pathSchema: JsonObject = { type: "string", minLength: 1, maxLength: 64 };

export function calculatorTool(): RegisteredTool {
  const definition: ToolDefinition = { ...metadata, name: "calculator", description: "Pure bounded arithmetic.",
    effects: "pure", resources: [],
    inputSchema: schema({ operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
      left: { type: "number" }, right: { type: "number" } }),
    outputSchema: schema({ value: { type: "number" } }) };
  return { definition, execute(input) {
    const result = executeCalculator({ providerCallId: "trusted-calculation", toolName: "calculator", arguments: input });
    if (result.status === "error") throw new ToolFault("EXECUTION_ERROR", "failed");
    return result.content;
  } };
}

export async function workspaceTools(explicitRoot: string): Promise<readonly RegisteredTool[]> {
  const workspace = await RestrictedWorkspace.configure(explicitRoot);
  return [{ definition: { ...metadata, name: "read_fixture", description: "Read one synthetic UTF-8 workspace file.",
    effects: "read_workspace", resources: ["workspace"], inputSchema: schema({ path: pathSchema }),
    outputSchema: schema({ text: { type: "string", maxLength: 8192 } }) },
    prepare: async (input) => { await workspace.checkRead(input.path as string); },
    execute: async (input, control) => ({ text: await workspace.read(input.path as string, control.signal) }) },
  { definition: { ...metadata, name: "write_report", description: "Create one new temporary experiment report; never overwrite.",
    effects: "write_workspace", resources: ["workspace"],
    inputSchema: schema({ path: pathSchema, text: { type: "string", maxLength: 8192 } }),
    outputSchema: schema({ bytesWritten: { type: "integer", minimum: 0, maximum: 8192 } }) },
    prepare: async (input) => {
      if (Buffer.byteLength(input.text as string, "utf8") > 8192) throw new ToolFault("INPUT_LIMIT_EXCEEDED", "not_started");
      await workspace.checkWrite(input.path as string);
    },
    execute: async (input, control) => ({ bytesWritten: await workspace.write(input.path as string, input.text as string, control.signal) }) }];
}
