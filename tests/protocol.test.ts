import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  decodeModelResponse,
  parseModelRequest,
  parseModelResponse
} from "../packages/model/src/protocol.js";

const call = (providerCallId: string) => ({
  providerCallId,
  toolName: "demo.inspect",
  arguments: { count: 1, tags: ["safe", null] }
});

describe("versioned model protocol", () => {
  it("accepts assistant proposals in context only after complete response validation", () => {
    const request = { schemaVersion: 1, runId: "run", modelTurnId: "turn", context: [
      { kind: "assistant_tool_calls", calls: [call("a"), call("b")] }
    ] };
    expect(parseModelRequest(request)).toEqual({ ok: true, value: request });
    expect(parseModelRequest({ ...request, context: [
      { kind: "assistant_tool_calls", calls: [call("a"), call("a")] }
    ] })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });
  it("preserves multiple proposals in provider order through JSON", () => {
    const raw = { schemaVersion: SCHEMA_VERSION, kind: "tool_calls", calls: [call("a"), call("b")] };
    const parsed = decodeModelResponse(JSON.stringify(raw));
    expect(parsed).toEqual({ ok: true, value: raw });
    if (parsed.ok && parsed.value.kind === "tool_calls") {
      expect(parsed.value.calls.map((item) => item.providerCallId)).toEqual(["a", "b"]);
    }
  });

  it.each([
    [{ schemaVersion: 99, kind: "final", text: "ok" }, "schema version"],
    [{ schemaVersion: 1, kind: "mystery" }, "Unknown"],
    [{ schemaVersion: 1, kind: "final", text: " " }, "nonempty"],
    [{ schemaVersion: 1, kind: "tool_calls", calls: [] }, "nonempty"],
    [{ schemaVersion: 1, kind: "tool_calls", calls: [call("a"), call("a")] }, "Duplicate"],
    [{ schemaVersion: 1, kind: "tool_calls", calls: [{ ...call("a"), arguments: "wrong" }] }, "Invalid tool call"],
    [{ schemaVersion: 1, kind: "tool_calls", calls: [{ ...call("a"), arguments: { count: Infinity } }] }, "Invalid tool call"]
  ])("rejects invalid response %j", (raw, message) => {
    const parsed = parseModelResponse(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain(message);
  });

  it("rejects malformed JSON and non-JSON request context", () => {
    expect(decodeModelResponse("{")).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    expect(parseModelRequest({
      schemaVersion: 1,
      runId: "run-1",
      modelTurnId: "turn-1",
      context: [{ kind: "tool_result", result: {
        schemaVersion: 1, providerCallId: "call-1", status: "success", content: undefined
      } }]
    })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("rejects sparse arrays, cycles and values hidden from JSON serialization", () => {
    const sparse = Array(1);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const withSymbol = { count: 1, [Symbol("hidden")]: "value" };
    for (const argumentsValue of [sparse, cyclic, withSymbol]) {
      expect(parseModelResponse({
        schemaVersion: 1,
        kind: "tool_calls",
        calls: [{ ...call("a"), arguments: argumentsValue }]
      })).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    }
  });
});
