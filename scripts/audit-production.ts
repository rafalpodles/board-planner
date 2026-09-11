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
  blockedBecause,
  staleEntries,
  ENFORCED_SEVERITIES,
  ACCEPTED_ADVISORIES,
  AUDITED_TREES,
  AUTHORITATIVE_REGISTRY,
  isAuthoritativeRegistry,
  type Finding,
} from "../src/lib/audit-policy.ts";

/**
 * Both packages that reach production. `mcp-server/` is a separate tree with its own lockfile and
 * its own copy of the same transitive dependencies — it shipped `fast-uri@3.1.0` while the root
 * had 3.1.3 — and auditing only the root left it unwatched (BP-599 review).
 *
 * `worker/` is deliberately not here, and the reason is remediability rather than ownership — its
 * lockfile IS committed, so an operator installs these pins, and the worker holds board credentials
 * and pushes branches. But a server advisory is cleared by a deploy this repo controls, while a
 * worker one needs every enrolled machine to re-install, and a red check on a branch cannot make
 * that happen. It reports zero vulnerable packages today; when that changes it wants a mechanism
 * that can reach those machines, not a gate here (BP-599 review).
 */
const AUDITED = AUDITED_TREES;

/**
 * Which host the audit will actually ask. A report from a registry that serves no advisories is
 * indistinguishable from a clean bill of health once parsed — empty `vulnerabilities`, full
 * `metadata`, every structural check satisfied — so the question has to be asked before the answer
 * arrives rather than inferred from it.
 */
function registryInUse(cwd: string): string {
  return execFileSync("npm", ["config", "get", "registry"], { cwd, encoding: "utf8" }).trim();
}

function auditReport(cwd: string): unknown {
  try {
    // The exit code answers neither question — non-zero on a finding and non-zero on a failure —
    // so the JSON is the answer and the policy decides. Only a failure to produce JSON is an error
    // here.
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
 * registry, bad auth — has no `vulnerabilities` at all. The exit code cannot be used to tell those
 * apart from a good run either: `npm audit` exits non-zero whenever it finds anything AND when it
 * fails outright, so the shape of the JSON is the only signal there is. Passing on it would be a
 * green tick meaning "we did not look".
 */
function mustHaveRun(report: unknown, cwd: string): unknown {
  if (ranSuccessfully(report)) return report;
  const message = (report as { message?: unknown })?.message;
  throw new Error(
    `npm audit in ${cwd} did not run: ${message ? String(message) : JSON.stringify(report).slice(0, 300)}. ` +
      `Refusing to report a clean bill of health from an audit that did not happen.`
  );
}

/**
 * Asked per tree, inside the loop, because `npm config get registry` is answered by whatever
 * `.npmrc` is in scope for that directory. Asking once about the root and then auditing
 * `mcp-server` would leave half the surface pointed wherever an `.npmrc` there said — which is
 * exactly the failure this check exists to stop (BP-599 review).
 *
 * The trailing slash is normalised away before comparing: npm returns `registry=…npmjs.org` as
 * written, and refusing it would mean a message naming two URLs that differ by one invisible
 * character.
 */
function mustAskAnAuthoritativeRegistry(cwd: string): string {
  const registry = registryInUse(cwd);
  if (isAuthoritativeRegistry(registry)) return registry;
  console.log(
    `::error::npm in ${cwd} is configured to use ${registry}, and this gate only trusts ` +
      `${AUTHORITATIVE_REGISTRY}. A registry that does not serve the advisory endpoint returns an ` +
      `empty report that looks exactly like a clean one, so a pass from here would mean nothing. ` +
      `Point npm at the public registry for this step, or decide deliberately that the mirror is ` +
      `authoritative and say so in src/lib/audit-policy.ts.`
  );
  process.exit(1);
}

/**
 * A proxy redirects the audit somewhere npm's own config cannot show: `npm config get https-proxy`
 * answers `null` for a standard `HTTPS_PROXY`, while the request goes through it all the same — and
 * a proxy answering `{}` produces the same structurally perfect empty report a mirror does. Not
 * something this gate can refuse without breaking every runner that legitimately needs one, so it
 * is named instead: a green tick should say where its answer came from (BP-599 review).
 *
 * **Origin only.** A proxy URL routinely carries userinfo, and printing it whole would put
 * `http://user:token@host` into a build log — a self-hosted runner, which is what has a proxy, has
 * that as a plain environment variable rather than as a registered secret, so nothing masks it.
 *
 * And *may*, not *did*: `NO_PROXY` can send the request straight past it, so the honest claim is
 * that a proxy is configured, not that this answer travelled through one. Saying otherwise would
 * be the same overclaim as a comment promising what the code does not do, moved into output a
 * person reads under pressure.
 */
const PROXY_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "npm_config_proxy",
  "npm_config_https_proxy",
];

function withoutCredentials(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    // Not a URL npm would use either, but printing the raw string is the one thing not to do
    return "(unparseable)";
  }
}

for (const name of PROXY_VARS) {
  const value = process.env[name];
  if (value) {
    console.log(`note: ${name} names ${withoutCredentials(value)} — this answer may have come through it.`);
  }
}
for (const name of ["NO_PROXY", "no_proxy"]) {
  const value = process.env[name];
  if (value) console.log(`note: ${name} is ${value}, so some hosts bypass any proxy above.`);
}

const blocking: Finding[] = [];
const acceptedIds = new Set<string>();
const seenIds = new Set<string>();

for (const cwd of AUDITED) {
  console.log(`Advisories for ${cwd} from ${mustAskAnAuthoritativeRegistry(cwd)}.`);
  const verdict = judge(mustHaveRun(auditReport(cwd), cwd), ACCEPTED_ADVISORIES, cwd);
  for (const finding of verdict.blocking) {
    console.log(
      `::error::${cwd}: ${finding.severity} advisory in ${finding.package}: ${finding.title} ` +
        `(${finding.id}) — ${blockedBecause(finding, ACCEPTED_ADVISORIES, cwd)}`
    );
    blocking.push(finding);
  }
  for (const finding of verdict.accepted) {
    console.log(`accepted in ${cwd}: ${finding.severity} ${finding.package} ${finding.id} — ${finding.title}`);
    // Counted by id, not by occurrence: an advisory live in both trees is one decision, and the
    // summary line saying "2 accepted" for it would misdescribe the allowlist
    acceptedIds.add(finding.id);
  }
  for (const finding of [...verdict.blocking, ...verdict.accepted]) seenIds.add(finding.id);
}

// Across every tree at once: an entry earning its keep in one of them is not dead, and a line that
// cries wolf is a line people stop reading
for (const entry of staleEntries(seenIds)) {
  console.log(
    `note: ${entry.id} (${entry.package}) is accepted in audit-policy.ts but no longer reported ` +
      `by any audited tree — delete the entry rather than leaving a reason nobody has re-read`
  );
}

if (blocking.length === 0) {
  console.log(
    `No unaccepted ${ENFORCED_SEVERITIES.join(" or ")} advisory in the production dependencies of ` +
      `${AUDITED.join(" or ")} (${acceptedIds.size} accepted).`
  );
  process.exit(0);
}

console.log(
  `${blocking.length} advisory(ies) stop this build. Bump the package — check whether the leaf can ` +
    `move on its own before concluding a pinned parent blocks it, which is how both wrong ` +
    `acceptances in BP-599 happened. Only where no fix exists short of a major does ` +
    `src/lib/audit-policy.ts take a reason, and it must name the tree it is about and be checked ` +
    `by loading what the entry point loads rather than by grepping a bundle.`
);
process.exit(1);
