import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { startPort } from "./start-port.mjs";

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(
  process.execPath,
  [next, "start", "-H", "0.0.0.0", "-p", startPort(process.cwd(), process.env), ...process.argv.slice(2)],
  { stdio: "inherit" }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 1));
