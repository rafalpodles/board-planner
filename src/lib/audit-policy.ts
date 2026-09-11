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

const MCP_CHAIN_UNREACHABLE =
  "Reaches the tree only through @modelcontextprotocol/sdk's optional express/hono server " +
  "transports. This app serves MCP through mcp-handler on a Next route and imports only " +
  "server/mcp.js, server/stdio.js and the auth types; the PM agent's MCP client is plain fetch. " +
  "Verified against the built output, not the import graph: no express, hono, ajv, qs, fast-uri " +
  "or ip-address code appears in .next/server or in .next/standalone/node_modules, while " +
  "nodemailer — a package that IS used — does appear, which is what makes the absence meaningful.";

const MCP_CHAIN_CLEARED_BY =
  "mcp-handler 1.1.0 pins @modelcontextprotocol/sdk to exactly 1.26.0, and mcp-handler 2.x peers " +
  "on a different package (@modelcontextprotocol/server), so clearing these means migrating the " +
  "/api/mcp handler. Delete these entries when that lands.";

export const ACCEPTED_ADVISORIES: AcceptedAdvisory[] = [
  ...[
    "GHSA-v2hh-gcrm-f6hx",
    "GHSA-7p8r-x3mc-p8w7",
    "GHSA-5jgf-p345-68v8",
    "GHSA-f65p-4m7j-42xc",
    "GHSA-fph4-wmhf-6fwf",
    "GHSA-jqff-g426-hqxp",
  ].map((id) => ({ id, package: "fast-uri", why: MCP_CHAIN_UNREACHABLE, clearedBy: MCP_CHAIN_CLEARED_BY })),
  ...["GHSA-mwp4-54f8-5fhr"].map((id) => ({
    id,
    package: "ip-address",
    why: MCP_CHAIN_UNREACHABLE,
    clearedBy: MCP_CHAIN_CLEARED_BY,
  })),
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
}

const GHSA = /GHSA-[0-9a-z-]+/i;

/**
 * Every enforced-severity advisory in the report, deduplicated by id.
 *
 * Read off the `via` entries rather than the package's own summary severity, because that summary
 * is the worst of the chain: a package can be reported "high" on account of a dependency's
 * advisory that has its own id and its own reason, and accepting the package would accept both.
 */
export function findings(report: unknown): Finding[] {
  const vulnerabilities = (report as AuditReport)?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") return [];

  const seen = new Map<string, Finding>();
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const via = Array.isArray(entry?.via) ? entry.via : [];
    for (const item of via) {
      if (!item || typeof item !== "object") continue;
      const { url, title, severity } = item as AuditVia;
      const id = GHSA.exec(String(url ?? ""))?.[0];
      if (!id) continue;
      if (!ENFORCED_SEVERITIES.includes(String(severity) as (typeof ENFORCED_SEVERITIES)[number])) continue;
      seen.set(id, { id, package: name, severity: String(severity), title: String(title ?? "") });
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
