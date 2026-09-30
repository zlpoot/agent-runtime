import { SCHEMA_VERSION, type ModelRequest } from "./protocol.js";
import { ScriptedFakeModel } from "./scripted-fake-model.js";

const request: ModelRequest = {
  schemaVersion: SCHEMA_VERSION,
  runId: "demo-run-1",
  modelTurnId: "demo-turn-1",
  context: [{ kind: "user", text: "synthetic inspection request" }]
};
const model = new ScriptedFakeModel([{
  type: "tool_calls",
  calls: [
    { providerCallId: "call-1", toolName: "demo.inspect", arguments: { item: "sample" } },
    { providerCallId: "call-2", toolName: "demo.inspect", arguments: { item: "second" } }
  ]
}]);

const response = await model.generate(request);
process.stdout.write(`${JSON.stringify({
  schemaVersion: SCHEMA_VERSION,
  runId: request.runId,
  modelTurnId: request.modelTurnId,
  response,
  observation: "proposal_only",
  executedToolCalls: 0
}, null, 2)}\n`);
