import { defaultWorkerDeps, createWorker } from "./wiring.js";
import { pathWithTools } from "./preflight.js";

// `node dist/main.js --preflight` answers "can this machine do the work" as JSON and exits, without
// registering anything or claiming anything. The menubar app runs this before it will enrol a
// machine, so the resolution lives here once rather than being written a second time in Swift —
// the login shell that reads .zprofile but not .zshrc, the on-disk fallback, and carrying node
// because npm's shebang is `env node` are all subtleties that were found by running it.
async function preflight(): Promise<void> {
  const deps = defaultWorkerDeps();
  const report = await deps.runPreflight({
    runner: deps.runner,
    env: deps.env,
    execPath: deps.execPath,
    isExecutable: deps.isExecutable,
  });

  process.stdout.write(
    JSON.stringify(
      {
        ok: report.ok,
        account: report.account,
        checks: report.checks,
        paths: report.paths,
        // What the app has to put on the spawned worker's PATH. Handing over the repaired string
        // rather than the ingredients keeps one implementation of the repair.
        path: pathWithTools(report.paths, deps.env.PATH ?? ""),
      },
      null,
      2
    ) + "\n"
  );
  process.exit(report.ok ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes("--preflight")) {
    await preflight();
    return;
  }

  const worker = createWorker();
  process.on("SIGTERM", () => worker.shutdown());
  process.on("SIGINT", () => worker.shutdown());
  await worker.run();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
