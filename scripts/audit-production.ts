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
 * `--omit=dev` on purpose: a path-traversal in the test runner is not a production exposure, and a
 * gate that fails on one teaches people to pass `--force`. The dev tree is still reported by a
 * plain `npm audit`; it is just not what stops a deploy.
 */
import { execFileSync } from "node:child_process";
import { judge, ENFORCED_SEVERITIES } from "../src/lib/audit-policy.ts";

function auditReport(): unknown {
  try {
    // `npm audit` exits non-zero whenever it finds anything at all, which is not the question being
    // asked here — the JSON is the answer, and the policy decides. Only a failure to produce JSON
    // is a real error.
    const out = execFileSync("npm", ["audit", "--json", "--omit=dev"], {
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
      `npm audit produced no usable JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const { blocking, accepted, stale } = judge(auditReport());

for (const entry of stale) {
  console.log(
    `note: ${entry.id} (${entry.package}) is accepted in audit-policy.ts but no longer reported — ` +
      `delete the entry rather than leaving a reason nobody has re-read`
  );
}

for (const finding of accepted) {
  console.log(`accepted: ${finding.severity} ${finding.package} ${finding.id} — ${finding.title}`);
}

if (blocking.length === 0) {
  console.log(
    `No unaccepted ${ENFORCED_SEVERITIES.join(" or ")} advisory in production dependencies ` +
      `(${accepted.length} accepted, ${stale.length} stale).`
  );
  process.exit(0);
}

for (const finding of blocking) {
  console.log(
    `::error::${finding.severity} advisory in ${finding.package}: ${finding.title} ` +
      `(${finding.id}). Bump it, or accept it in src/lib/audit-policy.ts with a reason the ` +
      `next person can check.`
  );
}
console.log(`${blocking.length} unaccepted advisory(ies) in production dependencies.`);
process.exit(1);
