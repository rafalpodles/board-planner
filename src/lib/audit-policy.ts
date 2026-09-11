/**
 * Which `npm audit` findings may pass the build, and why (BP-599).
 *
 * The problem this exists for is not the advisories themselves — those get bumped. It is that
 * "we looked at it and it does not reach us" was written on a board ticket in August, was true
 * then, and was quietly false three weeks later while nothing failed. A judgement about
 * reachability has to live where a build can re-check it, or it decays into folklore.
 *
 * So: **critical and high advisories against production dependencies fail the build**, and an
 * acceptance has to clear three bars at once — the exact GHSA id, the tree it is about, and npm
 * reporting no fix short of a major version. Keyed on id and tree rather than on the package, so a
 * *new* advisory in an already-accepted dependency still stops the build, and a reason written
 * about one program does not excuse the same finding in the other. The acceptance is of one
 * finding in one place, never of a dependency.
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

/**
 * The trees a `trees` entry may name. Exported so the allowlist can be held to it: a misspelled
 * tree matches nothing and the advisory blocks, which is the safe direction but leaves an entry
 * that reads as authoritative while doing nothing (BP-599 review).
 */
export const AUDITED_TREES = [".", "mcp-server"] as const;

/**
 * The registry whose answer this gate is willing to treat as authoritative.
 *
 * Nothing in a report distinguishes "the advisory database has nothing on these packages" from
 * "the host we asked does not serve advisories": a mirror answering `200 {}` on the bulk endpoint
 * produces a perfectly well-formed report with an empty `vulnerabilities` and a full `metadata`,
 * and every check in this file passes it. The only place that difference is visible is which host
 * was asked, so the gate asks — and refuses an unfamiliar one rather than inheriting whatever
 * `npm_config_registry` happened to be set to (BP-599 review).
 */
export const AUTHORITATIVE_REGISTRY = "https://registry.npmjs.org/";

export interface Finding {
  id: string;
  package: string;
  severity: string;
  title: string;
  /**
   * Whether npm says this can be bumped without a major, decided at read time rather than carried
   * as npm's raw shape. One advisory is reported under every package that pulls it in, and those
   * entries can disagree — so the merge has to be worst-case, and a boolean is the only thing that
   * merges with `||` without the consumer re-deriving it (BP-599 review).
   */
  bumpable: boolean;
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
 * well-formed object with an `error` key and no `vulnerabilities`. Its exit code cannot separate
 * those from a successful run either: it exits 1 whenever it finds anything at all, so failure and
 * "found three moderates" look identical from the outside and the JSON is the only answer. Reading
 * an empty verdict as "nothing found" is how a security gate reports success on a day it did no
 * work, which is worse than having no gate: it is a green tick that means nothing (BP-599 review).
 *
 * An earlier version of this note said npm exits 0 on an unreachable registry. It does not — that
 * reading came from a shell pipeline whose `$?` was `echo`'s.
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
 * Whether npm's `fixAvailable` means "you could just bump this".
 *
 * The default is the whole point. `false` and an absent field are npm saying no fix exists, which
 * is the one honest reason to accept something — so those permit. Everything else permits only
 * when it is a **confirmed** major: an object whose `isSemVerMajor` is literally `true`. A shape
 * this does not recognise — `{name, version}` with no flag, a stringified `"false"`, a number —
 * counts as bumpable and refuses the acceptance.
 *
 * That direction is deliberate. The first version returned "not bumpable" for anything it did not
 * recognise, so four unfamiliar shapes let an acceptance stand; and the guard exists precisely so
 * that nobody has to trust a judgement about what npm will emit (BP-599 review).
 */
function bumpableWithoutAMajor(fixAvailable: unknown): boolean {
  // Only an explicit `false` is npm saying there is no fix. Absent is npm not answering — every
  // real vulnerability entry carries this field — and `0` and `""` are falsy but unrecognised, so
  // all of them fall through to the refusing branch this guard was inverted to reach.
  if (fixAvailable === false) return false;
  if (fixAvailable && typeof fixAvailable === "object") {
    return (fixAvailable as { isSemVerMajor?: unknown }).isSemVerMajor !== true;
  }
  return true;
}

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
      // Guards `null`, which destructuring throws on. A string here names another package rather
      // than an advisory and needs no guard: it destructures to undefined fields and falls out at
      // the severity check below.
      if (!item) continue;
      const { url, title, severity } = item as AuditVia;
      if (!enforced(severity)) continue;
      const text = String(title ?? "");
      const id = GHSA.exec(String(url ?? ""))?.[0] ?? unidentified(name, text);
      // One advisory is reported under every package that pulls it in, and those entries can carry
      // different `fixAvailable` answers. Merged worst-case: if any of them says a bump would do,
      // the finding is bumpable, whatever order npm happened to list the packages in.
      const bumpable = bumpableWithoutAMajor(entry?.fixAvailable);
      const already = seen.get(id);
      seen.set(id, {
        id,
        package: already?.package ?? name,
        severity: String(severity).toLowerCase(),
        title: text,
        bumpable: bumpable || Boolean(already?.bumpable),
      });
    }
  }
  return [...seen.values()];
}

export interface Verdict {
  blocking: Finding[];
  accepted: Finding[];
}

export function judge(
  report: unknown,
  accepted: AcceptedAdvisory[] = ACCEPTED_ADVISORIES,
  tree = "."
): Verdict {
  const found = findings(report);
  // An entry whose id is not a real advisory id is ignored outright, so the synthetic key given to
  // an unidentified finding cannot be written into the allowlist to silence it. The shipped-list
  // test asserts the same shape, but on an empty list that assertion is vacuously true — the
  // property has to live here (BP-599 review).
  const forThisTree = new Map(
    accepted.filter((a) => a.trees.includes(tree) && GHSA.test(a.id)).map((a) => [a.id, a])
  );

  const blocking: Finding[] = [];
  const allowed: Finding[] = [];
  for (const finding of found) {
    if (!forThisTree.has(finding.id) || finding.bumpable) blocking.push(finding);
    else allowed.push(finding);
  }

  return { blocking, accepted: allowed };
}

/**
 * Entries whose advisory no longer appears **anywhere** — the reason nobody has re-read, sitting
 * where the next person will assume it was checked. An allowlist that only ever grows is how the
 * thing this file exists to prevent comes back.
 *
 * Takes the ids seen across every audited tree rather than one verdict's, because an entry earning
 * its keep in one program is not dead. Judging it per-tree would report an mcp-server acceptance
 * as stale while looking at the root, and a line that cries wolf is a line people stop reading.
 */
export function staleEntries(
  seenAnywhere: Iterable<string>,
  accepted: AcceptedAdvisory[] = ACCEPTED_ADVISORIES
): AcceptedAdvisory[] {
  const seen = new Set(seenAnywhere);
  return accepted.filter((a) => !seen.has(a.id));
}

/** Why a blocked finding was blocked, for a message the reader can act on. */
export function blockedBecause(finding: Finding, accepted: AcceptedAdvisory[], tree: string): string {
  const entry = accepted.find((a) => a.id === finding.id && a.trees.includes(tree));
  if (entry) {
    return "npm reports a fix short of a major, so this cannot be accepted — bump it";
  }
  const elsewhere = accepted.find((a) => a.id === finding.id);
  if (elsewhere) {
    return `accepted, but only for ${elsewhere.trees.join(", ")} — this is ${tree}`;
  }
  return "not accepted in src/lib/audit-policy.ts";
}
