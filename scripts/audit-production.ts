/**
 * Fails the build on a critical or high advisory against a production dependency, unless that
 * exact advisory is accepted in `src/lib/audit-policy.ts` with a reason (BP-599).
 *
 *   node scripts/audit-production.ts
 *
 * Node 26 runs TypeScript directly, so this needs no build step and no extra dev dependency — it
 * can run immediately after `npm ci`, which is the only moment at which the answer is about the
 * tree CI is actually going to build.
 *
 * `--omit=dev` on purpose: a path traversal in the test runner is not a production exposure, and a
 * gate that fails on one teaches people to reach for `--force`. Worth knowing that this repo's
 * `dependencies` are wider than "what the server runs" — `@types/*`, `postcss` and
 * `@tailwindcss/postcss` are declared there — so the audited tree already includes build-time
 * packages, and the flag removes less than its name suggests. The dev tree is still reported by a
 * plain `npm audit`; it is just not what stops a deploy.
 */
import { execFileSync } from "node:child_process";
import {
  judge,
  ranSuccessfully,
  ENFORCED_SEVERITIES,
  ACCEPTED_ADVISORIES,
  type Finding,
} from "../src/lib/audit-policy.ts";

/**
 * Both packages that reach production. `mcp-server/` is a separate tree with its own lockfile and
 * its own copy of the same transitive dependencies — it shipped `fast-uri@3.1.0` while the root
 * had 3.1.3 — and auditing only the root left it unwatched (BP-599 review).
 *
 * `worker/` is deliberately not here: it runs on a machine somebody enrolled, not on the server,
 * and its tree is the operator's to keep. Say so rather than leaving the omission to be guessed at.
 */
const AUDITED = [".", "mcp-server"];

function auditReport(cwd: string): unknown {
  try {
    // `npm audit` exits non-zero whenever it finds anything at all, which is not the question being
    // asked here — the JSON is the answer, and the policy decides. Only a failure to produce JSON
    // is a real error.
    const out = execFileSync("npm", ["audit", "--json", "--omit=dev"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (error) {
    const stdout = (error as { stdout?: string })?.stdout;
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {
        // fall through to the throw below
      }
    }
    throw new Error(
      `npm audit in ${cwd} produced no usable JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * A report that is well-formed JSON but is npm telling us it could not run — no lockfile, no
 * registry, bad auth — has no `vulnerabilities` at all, and `npm audit` exits 0 for at least the
 * unreachable-registry case. Passing on that is a green tick meaning "we did not look".
 */
function mustHaveRun(report: unknown, cwd: string): unknown {
  if (ranSuccessfully(report)) return report;
  const message = (report as { message?: unknown })?.message;
  throw new Error(
    `npm audit in ${cwd} did not run: ${message ? String(message) : JSON.stringify(report).slice(0, 300)}. ` +
      `Refusing to report a clean bill of health from an audit that did not happen.`
  );
}

const blocking: Finding[] = [];
const accepted: Finding[] = [];
const seenIds = new Set<string>();

for (const cwd of AUDITED) {
  const verdict = judge(mustHaveRun(auditReport(cwd), cwd));
  for (const finding of verdict.blocking) {
    console.log(`::error::${cwd}: ${finding.severity} advisory in ${finding.package}: ${finding.title} (${finding.id})`);
    blocking.push(finding);
  }
  for (const finding of verdict.accepted) {
    console.log(`accepted in ${cwd}: ${finding.severity} ${finding.package} ${finding.id} — ${finding.title}`);
    accepted.push(finding);
  }
  for (const finding of [...verdict.blocking, ...verdict.accepted]) seenIds.add(finding.id);
}

// Stale is judged across BOTH trees: an entry earning its keep in one of them is not dead, and
// reporting it as dead per-package would teach people to ignore the line
for (const entry of ACCEPTED_ADVISORIES) {
  if (seenIds.has(entry.id)) continue;
  console.log(
    `note: ${entry.id} (${entry.package}) is accepted in audit-policy.ts but no longer reported ` +
      `by either package — delete the entry rather than leaving a reason nobody has re-read`
  );
}

if (blocking.length === 0) {
  console.log(
    `No unaccepted ${ENFORCED_SEVERITIES.join(" or ")} advisory in the production dependencies of ` +
      `${AUDITED.join(" or ")} (${accepted.length} accepted).`
  );
  process.exit(0);
}

console.log(
  `${blocking.length} unaccepted advisory(ies). Bump the package, or accept the advisory in ` +
    `src/lib/audit-policy.ts with a reason the next person can check — and check it by loading ` +
    `what the entry point loads, not by grepping a bundle.`
);
process.exit(1);
