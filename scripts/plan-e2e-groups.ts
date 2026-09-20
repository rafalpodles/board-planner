/**
 * Decides which e2e/groups.ts Playwright groups a CI run needs, and appends that list as JSON
 * straight to $GITHUB_OUTPUT (as `groups=[...]`) for the `plan_e2e` workflow job — not to stdout:
 * piping this script's stdout through `$(...)` reliably came back empty on the Linux runner for
 * reasons that were never pinned down, so the workflow step no longer captures it that way.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/plan-e2e-groups.ts
 *
 * Runs before `npm ci`, so it must import nothing outside this repo's own TypeScript — Node 26
 * runs that directly (see scripts/audit-production.ts).
 *
 * Full, never partial, whenever the answer isn't cheap and safe to compute: a manual
 * workflow_dispatch re-run, a push straight to main (the branch Railway auto-deploys from, and the
 * one place a partial answer would run right before a deploy), or any failure along the way —
 * including a bug in this file itself. Ambiguity always errs toward running more tests, not fewer.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { GROUP_NAMES } from "../e2e/groups.ts";
import { computeAffectedGroups } from "../e2e/affected-groups.ts";

function changedFiles(): string[] {
  const out = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function decide(): string[] {
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") return [...GROUP_NAMES];
  if (process.env.GITHUB_REF_NAME === "main") return [...GROUP_NAMES];
  return computeAffectedGroups(changedFiles());
}

let groups: string[];
try {
  groups = decide();
} catch {
  groups = [...GROUP_NAMES];
}

const line = `groups=${JSON.stringify(groups)}\n`;
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, line);
} else {
  process.stdout.write(line);
}
