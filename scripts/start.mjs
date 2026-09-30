import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { nextStartArgs } from "./start-port.mjs";

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [next, ...nextStartArgs(process.cwd(), process.env, process.argv.slice(2))], {
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 1));
