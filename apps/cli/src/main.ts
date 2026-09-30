import { resolveCliArgs } from "./index.js";

const response = resolveCliArgs(process.argv.slice(2));
const output = response.exitCode === 0 ? process.stdout : process.stderr;
output.write(`${response.message}\n`);
process.exitCode = response.exitCode;
