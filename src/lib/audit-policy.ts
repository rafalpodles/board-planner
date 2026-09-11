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
  /** Why the vulnerable code path cannot be reached from this deployment */
  why: string;
  /** What would make this entry unnecessary, so it can be deleted rather than inherited */
  clearedBy: string;
}

/**
 * The one advisory this repo accepts, and the reason had to be rewritten after a reviewer refuted
 * the first version of it (BP-599 review).
 *
 * What I claimed first: the whole `@modelcontextprotocol/sdk` chain reaches the tree only through
 * optional express and hono transports, checked by grepping the built server output. Both halves
 * were wrong. `fast-uri` arrives through the SDK's **core** `Server` class — `server/index.js`
 * imports an Ajv-backed schema validator, which loads `ajv`, which loads `fast-uri`, and the
 * constructor runs it once per MCP session. And grepping bundles never proved anything either
 * way: a minifier does not preserve a package's name, so absence of the string is not absence of
 * the code. Those six advisories are now fixed by a `fast-uri` bump instead of excused.
 *
 * The instrument that settles this question is loading what the route loads and reading the module
 * cache:
 *
 *     node -e "…; await import('mcp-handler'); Object.keys(require.cache) …"
 *
 * which reports `fast-uri` and `ajv` loaded, and `ip-address`, `express`, `express-rate-limit`,
 * `hono` and `qs` not.
 */
const IP_ADDRESS_UNREACHABLE =
  "Reaches the tree under express-rate-limit, which the SDK imports only from its Express OAuth " +
  "handlers (server/auth/handlers/{authorize,token,register,revoke}.js). This app serves MCP " +
  "through mcp-handler on a Next route and runs its own OAuth, so none of those modules is " +
  "imported. Measured rather than reasoned: importing what src/app/api/mcp/route.ts imports " +
  "leaves ip-address absent from the module cache, while fast-uri and ajv — which the same import " +
  "does pull in — are present, so the absence is a reading and not a gap in the method.";

const IP_ADDRESS_CLEARED_BY =
  "A patched ip-address above 10.3.0, or the SDK dropping express-rate-limit. Unlike fast-uri, " +
  "which had a fix inside its own semver range, there is none to bump to yet — re-check before " +
  "assuming this entry is still needed.";

export const ACCEPTED_ADVISORIES: AcceptedAdvisory[] = [
  {
    id: "GHSA-mwp4-54f8-5fhr",
    package: "ip-address",
    why: IP_ADDRESS_UNREACHABLE,
    clearedBy: IP_ADDRESS_CLEARED_BY,
  },
];

export const ENFORCED_SEVERITIES = ["critical", "high"] as const;

export interface Finding {
  id: string;
  package: string;
  severity: string;
  title: string;
}

/** One advisory as `npm audit --json` nests it under `vulnerabilities[name].via[]`. */
interface AuditVia {
  url?: unknown;
  title?: unknown;
  severity?: unknown;
}

interface AuditReport {
  vulnerabilities?: Record<string, { severity?: unknown; via?: unknown }>;
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
      seen.set(id, { id, package: name, severity: String(severity).toLowerCase(), title: text });
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
 * `stale` is reported because an allowlist that only ever grows is how the thing this file exists
 * to prevent comes back: an entry whose advisory no longer appears is a reason nobody has re-read,
 * sitting where the next person will assume it was checked.
 */
export function judge(report: unknown, accepted: AcceptedAdvisory[] = ACCEPTED_ADVISORIES): Verdict {
  const found = findings(report);
  const acceptedById = new Map(accepted.map((a) => [a.id, a]));
  const foundIds = new Set(found.map((f) => f.id));

  return {
    blocking: found.filter((f) => !acceptedById.has(f.id)),
    accepted: found.filter((f) => acceptedById.has(f.id)),
    stale: accepted.filter((a) => !foundIds.has(a.id)),
  };
}
