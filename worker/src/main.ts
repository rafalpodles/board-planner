import { defaultWorkerDeps, createWorker } from "./wiring.js";
import { asReported, pathWithTools } from "./preflight.js";
import { codexUsable } from "./agents/codex.js";
import { codexSourceHome } from "./env.js";
import { stateDirFrom } from "./config.js";
import { configuredCommitIdentity, pinnedAccount } from "./github-account.js";
import { lockStateDir, StateDirBusy } from "./state-lock.js";

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
    // The same pin the running worker reads, so the app's checklist answers for the identity that
    // will actually push rather than for whichever account gh has active while it is on screen
    pinnedGithubAccount: pinnedAccount(deps.readFile, stateDirFrom(deps.env)),
    configuredCommitIdentity: configuredCommitIdentity(deps.readFile, stateDirFrom(deps.env)),
  });
  // The test the running worker makes, so the app does not offer Connect to a machine that would claim nothing
  const checks = asReported(report.checks, report.agents.includes("codex") && codexUsable(report.paths.codex, codexSourceHome(deps.env)));
  const ok = checks.every((check) => check.ok);

  process.stdout.write(
    JSON.stringify(
      {
        ok,
        account: report.account,
        checks,
        paths: report.paths,
        githubAccounts: report.githubAccounts,
        githubAccount: report.githubAccount,
        githubPinned: report.githubPinned,
        // What the app has to put on the spawned worker's PATH. Handing over the repaired string
        // rather than the ingredients keeps one implementation of the repair.
        path: pathWithTools(report.paths, deps.env.PATH ?? ""),
      },
      null,
      2
    ) + "\n"
  );
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes("--preflight")) {
    await preflight();
    return;
  }

  // Before createWorker, which already replaces the control socket and opens the control stream
  const deps = defaultWorkerDeps();
  await lockStateDir(stateDirFrom(deps.env));
  const worker = createWorker(deps);
  process.on("SIGTERM", () => worker.shutdown());
  process.on("SIGINT", () => worker.shutdown());
  await worker.run();
}

main().catch((error) => {
  console.error(error instanceof StateDirBusy ? error.message : error);
  process.exit(1);
});
