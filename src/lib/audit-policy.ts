/**
 * Which `npm audit` findings may pass the build, and why (BP-599).
 *
 * The problem this exists for is not the advisories themselves — those get bumped. It is that
 * "we looked at it and it does not reach us" was written on a board ticket in August, was true
 * then, and was quietly false three weeks later while nothing failed. A judgement about
 * reachability has to live where a build can re-check it, or it decays into folklore.
 *
 * So: **critical and high advisories against production dependencies fail the build** unless the
 * exact advisory is listed below with a reason. Keyed on the GHSA id rather than the package, so a
 * *new* advisory in an already-accepted package still stops the build — the acceptance is of one
 * finding, never of a dependency.
 *
 * Moderate and low are reported, not enforced. There is no cliff that makes them safe; the line is
 * where a gate stops being read and starts being routed around, and every moderate on this repo
 * today is either dev-only or build-time.
 *
 * Lives under `src/lib` rather than beside the script that calls it because that is what `npm test`
 * and `tsc --noEmit` cover: a policy nothing type-checks is the same failure mode one step along.
 */

export interface AcceptedAdvisory {
  /** GHSA id, exactly as `npm audit --json` reports it in the advisory's `url` */
  id: string;
  package: string;
  /**
   * Which audited trees this reason covers. They are separate programs with separate lockfiles and
   * they are built to diverge — the root pins its MCP SDK through mcp-handler while mcp-server
   * floats — so a reason written about one of them must not quietly excuse the same advisory in
   * the other (BP-599 review).
   */
  trees: string[];
  /** Why the vulnerable code path cannot be reached from this deployment */
  why: string;
  /** What would make this entry unnecessary, so it can be deleted rather than inherited */
  clearedBy: string;
}

/**
 * Empty, and that is the finding rather than an oversight.
 *
 * Two reasons were written here and both were wrong in the same way: I concluded that `fast-uri`
 * and then `ip-address` could not be bumped because the SDK above them is pinned, without checking
 * whether the leaf itself could move. Both could — 3.1.6 and 10.3.1 were inside ranges their
 * parents already declared — so six advisories and then a seventh were fixed rather than excused.
 *
 * The guard below is what stops that happening a third time: an advisory npm reports as fixable
 * without a major bump cannot be accepted at all, however good the reason reads.
 */
export const ACCEPTED_ADVISORIES: AcceptedAdvisory[] = [];

export const ENFORCED_SEVERITIES = ["critical", "high"] as const;

export interface Finding {
  id: string;
  package: string;
  severity: string;
  title: string;
  /**
   * What npm says about remediation for the package this advisory came under: `true` when a fix is
   * in reach, an object when it needs a major, `false` when there is none.
   */
  fixAvailable: boolean | { isSemVerMajor?: boolean };
}

/** One advisory as `npm audit --json` nests it under `vulnerabilities[name].via[]`. */
interface AuditVia {
  url?: unknown;
  title?: unknown;
  severity?: unknown;
}

interface AuditReport {
  vulnerabilities?: Record<string, { severity?: unknown; via?: unknown; fixAvailable?: unknown }>;
  metadata?: unknown;
  error?: unknown;
}

const GHSA = /GHSA-[0-9a-z-]+/i;

/**
 * Whether this is an audit that ran, as opposed to one that failed and said so in JSON.
 *
 * `npm audit` reports an unreachable registry, a missing lockfile and an auth failure as a
 * well-formed object with an `error` key and no `vulnerabilities` — and exits 0 for at least the
 * first of those. Treating that as "nothing found" is how a security gate reports success on a day
 * it did no work, which is worse than having no gate: it is a green tick that means nothing
 * (BP-599 review).
 */
export function ranSuccessfully(report: unknown): boolean {
  const r = report as AuditReport;
  if (!r || typeof r !== "object") return false;
  if (r.error !== undefined) return false;
  return Boolean(r.vulnerabilities && typeof r.vulnerabilities === "object" && r.metadata);
}

const enforced = (severity: unknown) =>
  ENFORCED_SEVERITIES.includes(String(severity).toLowerCase() as (typeof ENFORCED_SEVERITIES)[number]);

/**
 * An advisory serious enough to enforce but carrying no id we can key on. It gets one that no
 * allowlist can contain — every accepted entry is asserted to be a real GHSA id — so it blocks and
 * has to be looked at by a person.
 *
 * Skipping it instead was the original behaviour, and a test pinned it as intentional with a
 * comment saying the opposite of what the code did. Something unrecognised in a security feed is
 * the last thing that should pass quietly.
 */
const unidentified = (pkg: string, title: string) => `UNIDENTIFIED:${pkg}:${title}`;

/**
 * Every enforced-severity advisory in the report, deduplicated by id.
 *
 * Read off the `via` entries rather than the package's own summary severity, because that summary
 * is the worst of the chain: a package can be reported "high" on account of a dependency's
 * advisory that has its own id and its own reason, and accepting the package would accept both.
 *
 * Severity is judged before the id, and case-insensitively, so that neither an unfamiliar spelling
 * nor a missing advisory URL can turn a critical into silence.
 */
export function findings(report: unknown): Finding[] {
  const vulnerabilities = (report as AuditReport)?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") return [];

  const seen = new Map<string, Finding>();
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const via = Array.isArray(entry?.via) ? entry.via : [];
    for (const item of via) {
      // A string here names another package rather than an advisory; it carries no severity, so it
      // falls out below rather than needing a guard of its own
      if (!item || typeof item !== "object") continue;
      const { url, title, severity } = item as AuditVia;
      if (!enforced(severity)) continue;
      const text = String(title ?? "");
      const id = GHSA.exec(String(url ?? ""))?.[0] ?? unidentified(name, text);
      seen.set(id, {
        id,
        package: name,
        severity: String(severity).toLowerCase(),
        title: text,
        fixAvailable: (entry?.fixAvailable ?? false) as Finding["fixAvailable"],
      });
    }
  }
  return [...seen.values()];
}

export interface Verdict {
  blocking: Finding[];
  accepted: Finding[];
  /** Entries that matched nothing in the report — a decision whose subject is gone */
  stale: AcceptedAdvisory[];
}

/**
 * An acceptance npm itself contradicts. Both wrong entries this file has carried were of exactly
 * this shape: a careful reason for tolerating something that had a patched version sitting inside
 * a range its parent already declared. npm puts that answer in the report it hands us, so the
 * cheapest way to stop writing the reason a third time is to refuse it.
 *
 * A fix needing a major version is a different question — it can break the thing it is protecting
 * — so that one may still be argued.
 */
function bumpableWithoutAMajor(finding: Finding): boolean {
  const fix = finding.fixAvailable;
  if (fix === true) return true;
  return typeof fix === "object" && fix !== null && fix.isSemVerMajor === false;
}

/**
 * `stale` is reported because an allowlist that only ever grows is how the thing this file exists
 * to prevent comes back: an entry whose advisory no longer appears is a reason nobody has re-read,
 * sitting where the next person will assume it was checked.
 */
export function judge(
  report: unknown,
  accepted: AcceptedAdvisory[] = ACCEPTED_ADVISORIES,
  tree = "."
): Verdict {
  const found = findings(report);
  const forThisTree = new Map(
    accepted.filter((a) => a.trees.includes(tree)).map((a) => [a.id, a])
  );
  const foundIds = new Set(found.map((f) => f.id));

  const blocking: Finding[] = [];
  const allowed: Finding[] = [];
  for (const finding of found) {
    if (!forThisTree.has(finding.id) || bumpableWithoutAMajor(finding)) blocking.push(finding);
    else allowed.push(finding);
  }

  return {
    blocking,
    accepted: allowed,
    stale: accepted.filter((a) => !foundIds.has(a.id)),
  };
}

/** Why a blocked finding was blocked, for a message the reader can act on. */
export function blockedBecause(finding: Finding, accepted: AcceptedAdvisory[], tree: string): string {
  const entry = accepted.find((a) => a.id === finding.id && a.trees.includes(tree));
  if (entry && bumpableWithoutAMajor(finding)) {
    return "npm reports a fix within the declared ranges, so this cannot be accepted — bump it";
  }
  return "not accepted in src/lib/audit-policy.ts";
}
