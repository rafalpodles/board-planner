import { defaultWorkerDeps, createWorker } from "./wiring.js";
import { pathWithTools } from "./preflight.js";
import { stateDirFrom } from "./config.js";
import { pinnedAccount } from "./github-account.js";

async function preflight(): Promise<void> {
  const deps = defaultWorkerDeps();
  const report = await deps.runPreflight({
    runner: deps.runner,
    env: deps.env,
    execPath: deps.execPath,
    isExecutable: deps.isExecutable,
    pinnedGithubAccount: pinnedAccount(deps.readFile, stateDirFrom(deps.env)),
  });

  process.stdout.write(
    JSON.stringify(
      {
        ok: report.ok,
        account: report.account,
        checks: report.checks,
        paths: report.paths,
        githubAccounts: report.githubAccounts,
        githubAccount: report.githubAccount,
        githubPinned: report.githubPinned,
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
