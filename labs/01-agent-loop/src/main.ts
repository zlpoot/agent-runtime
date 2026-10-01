import { createInterface } from "node:readline";
import { HELP, parseArgs } from "./cli.js";
import { runLab, type LabTraceEvent, type TeachingCheckpoint } from "./engine.js";

function describe(event: LabTraceEvent): string {
  if (event.kind === "TeachingPause") {
    return `${event.labSequence}. TeachingPause #${event.ordinal}: ${event.stage}`;
  }
  if (event.kind === "LabObservation") {
    return `${event.labSequence}. LabObservation: ${event.status}/${event.reason}; `
      + `modelTurns=${event.modelTurns}, toolCommands=${event.toolCommands}, `
      + `calculatorExecutions=${event.calculatorExecutions}, `
      + `lastModelToolResults=${event.lastModelToolResults}, proposals=${event.proposedToolCalls}`;
  }
  const detail = event.kind === "RunEnded" ? `: ${event.status}/${event.reason}` : "";
  return `${event.labSequence}. ${event.kind}${detail}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === "help") { console.log(HELP); return; }
  if (!options.jsonl) {
    console.log("Synthetic fixture: calculator proposal add(2, 3). Inspect never executes it.");
  }
  const controller = new AbortController();
  // Start consuming immediately so piped Enter lines are queued before each pause.
  const input = options.mode === "step"
    ? createInterface({ input: process.stdin, crlfDelay: Infinity }) : undefined;
  const lines = input?.[Symbol.asyncIterator]();
  const cancel = (): void => { controller.abort(); input?.close(); };
  process.on("SIGINT", cancel);
  const advance = async (checkpoint: TeachingCheckpoint, signal: AbortSignal): Promise<boolean> => {
    process.stderr.write(`[step ${checkpoint.ordinal}: ${checkpoint.stage}] `
      + "Write your prediction in your record; Enter continues, q/EOF cancels.\n");
    if (signal.aborted) return false;
    const line = await lines!.next();
    return !line.done && line.value.trim() === "" && !signal.aborted;
  };
  try {
    const result = await runLab({ mode: options.mode, limits: options.limits, controller,
      ...(options.fault === undefined ? {} : { fault: options.fault }),
      ...(options.mode === "step" ? { advance } : {}),
      onEvent(event) { console.log(options.jsonl ? JSON.stringify(event) : describe(event)); }
    });
    // Expected faults/budget endings are observations, not CLI infrastructure failures.
    if (result.observation.status === "cancelled") process.exitCode = 130;
  } finally {
    input?.close();
    process.off("SIGINT", cancel);
  }
}

main().catch(() => {
  // Never print caught input, provider errors or stack traces to public evidence.
  process.stderr.write("Lab input or execution failed. Use --help and check the documented command.\n");
  process.exitCode = 1;
});
