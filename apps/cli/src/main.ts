import { resolveCliArgs } from "./index.js";
import { outcomeExitCode, runDemo } from "./demo.js";

const response = resolveCliArgs(process.argv.slice(2));
if (response.demo === undefined) {
  const output = response.exitCode === 0 ? process.stdout : process.stderr;
  output.write(`${response.message}\n`);
  process.exitCode = response.exitCode;
} else {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const result = await runDemo(response.demo, (line) => process.stdout.write(`${line}\n`), controller);
    process.exitCode = outcomeExitCode(result);
  } catch {
    process.stderr.write("Demo failed before a visible runtime outcome.\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
