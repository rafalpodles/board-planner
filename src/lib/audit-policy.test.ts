import { describe, it, expect } from "vitest";
import {
  judge,
  findings,
  ranSuccessfully,
  staleEntries,
  ACCEPTED_ADVISORIES,
  AUDITED_TREES,
  type AcceptedAdvisory,
} from "./audit-policy";

/**
 * BP-599. The gate this backs is the only thing standing between the repo and the situation that
 * created the ticket: a reachability judgement written down in August, true when written, false
 * three weeks later, and nothing failing in between.
 *
 * Driven with synthetic reports rather than by shelling out to `npm audit`. A test that called the
 * registry would change its verdict on a day nobody touched this repo, which is the opposite of
 * what a gate is for — and it could not exercise the cases below at all, since they are about
 * reports this project does not currently produce.
 */

const via = (id: string, severity: string, title = "something") => ({
  source: 1,
  name: "pkg",
  title,
  url: `https://github.com/advisories/${id}`,
  severity,
});

/**
 * `fixAvailable: false` by default. The guard added in the BP-599 review refuses an acceptance for
 * anything npm says is bumpable, so a fixture that left this out would have its acceptances
 * overruled for a reason the case was not about.
 */
const report = (
  vulnerabilities: Record<string, { severity: string; via: unknown[]; fixAvailable?: unknown }>
) => ({
  vulnerabilities: Object.fromEntries(
    Object.entries(vulnerabilities).map(([k, v]) => [k, { fixAvailable: false, ...v }])
  ),
  metadata: { vulnerabilities: { total: 0 } },
});

const accept = (over: Partial<AcceptedAdvisory> & { id: string }): AcceptedAdvisory => ({
  package: "pkg",
  trees: ["."],
  why: "unreachable for a reason of at least the required length to satisfy the shape test",
  clearedBy: "a ticket naming what would clear it",
  ...over,
});

describe("what the gate blocks on", () => {
  it("blocks a critical nobody has accepted", () => {
    const verdict = judge(
      report({ next: { severity: "critical", via: [via("GHSA-aaaa-bbbb-cccc", "critical", "RCE")] } }),
      []
    );

    expect(verdict.blocking.map((f) => f.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(verdict.blocking[0]).toMatchObject({ package: "next", severity: "critical", title: "RCE" });
  });

  it("blocks a high the same way", () => {
    const verdict = judge(report({ p: { severity: "high", via: [via("GHSA-1111-2222-3333", "high")] } }), []);

    expect(verdict.blocking).toHaveLength(1);
  });

  /**
   * The line is drawn at high on purpose. Moderate and low are reported by `npm audit` and not
   * enforced, so this is the assertion that says where the boundary is rather than leaving it to
   * be inferred from whichever severities the repo happens to have today.
   */
  it.each(["moderate", "low", "info"])("does not block on %s", (severity) => {
    const verdict = judge(report({ p: { severity, via: [via("GHSA-4444-5555-6666", severity)] } }), []);

    expect(verdict.blocking).toEqual([]);
    // Not merely unblocked — unseen. `accepted` is empty here whatever the code does, so the claim
    // that this severity never reaches the gate is `findings` returning nothing at all.
    expect(findings(report({ p: { severity, via: [via("GHSA-4444-5555-6666", severity)] } }))).toEqual([]);
  });

  /**
   * The script calls `judge(report)` with one argument, so the default is what production uses.
   * Asserted against the shipped list being empty, which is the state this ticket ended in: a
   * finding a supplied list would accept must still block when the default is used.
   */
  it("uses this repo's allowlist when the caller names none", () => {
    const one = report({ p: { severity: "high", via: [via("GHSA-default-0006", "high")] } });

    expect(judge(one, [accept({ id: "GHSA-default-0006", package: "p" })]).blocking).toEqual([]);
    expect(judge(one).blocking.map((f) => f.id)).toEqual(["GHSA-default-0006"]);
  });
});

describe("what an acceptance actually accepts", () => {
  const accepted = [accept({ id: "GHSA-known-0000-0000", package: "fast-uri" })];

  it("lets the listed advisory through", () => {
    const verdict = judge(
      report({ "fast-uri": { severity: "high", via: [via("GHSA-known-0000-0000", "high")] } }),
      accepted
    );

    expect(verdict.blocking).toEqual([]);
    expect(verdict.accepted.map((f) => f.id)).toEqual(["GHSA-known-0000-0000"]);
  });

  /**
   * The property the whole design turns on: acceptance is of one finding, never of a dependency.
   * Keying the allowlist on the package name would make a brand-new advisory in an already-excused
   * package silent, which is exactly the failure this gate is meant to catch.
   */
  it("still blocks a NEW advisory in the same package", () => {
    const verdict = judge(
      report({
        "fast-uri": {
          severity: "high",
          via: [via("GHSA-known-0000-0000", "high"), via("GHSA-brand-new-9999", "high", "a fresh one")],
        },
      }),
      accepted
    );

    expect(verdict.blocking.map((f) => f.id)).toEqual(["GHSA-brand-new-9999"]);
    expect(verdict.accepted.map((f) => f.id)).toEqual(["GHSA-known-0000-0000"]);
  });

  it("reports an acceptance whose advisory has gone as stale", () => {
    expect(staleEntries([], accepted).map((a) => a.id)).toEqual(["GHSA-known-0000-0000"]);
  });

  // The control: an entry that is still doing work is not reported as stale, so the signal means
  // something when it appears
  it("does not call an acceptance stale while its advisory is still reported", () => {
    expect(staleEntries(["GHSA-known-0000-0000"], accepted)).toEqual([]);
  });

  /**
   * Staleness is asked across every tree at once, never per verdict. An entry scoped to mcp-server
   * is doing its job there while the root's verdict has never heard of it, and reporting it dead
   * on that basis is how a line stops being read.
   */
  it("does not call an entry stale because the tree being judged did not see it", () => {
    const mcpOnly = [accept({ id: "GHSA-scoped-0009", package: "p", trees: ["mcp-server"] })];
    const one = report({ p: { severity: "high", via: [via("GHSA-scoped-0009", "high")] } });

    expect(judge(one, mcpOnly, ".").blocking.map((f) => f.id)).toEqual(["GHSA-scoped-0009"]);
    expect(staleEntries(["GHSA-scoped-0009"], mcpOnly)).toEqual([]);
  });
});

describe("reading the report", () => {
  /**
   * `npm audit` gives a package a summary severity that is the worst of its whole chain, and lists
   * the individual advisories under `via`. Judging on the summary would let one acceptance cover
   * findings it was never written about — and `via` also carries plain strings naming other
   * packages, which carry no id and must be skipped rather than crashing the gate.
   */
  it("reads the advisories, not the package's summary severity", () => {
    const verdict = judge(
      report({
        parent: { severity: "critical", via: ["child", via("GHSA-only-real-0001", "high")] },
      }),
      []
    );

    expect(verdict.blocking.map((f) => f.id)).toEqual(["GHSA-only-real-0001"]);
    expect(verdict.blocking[0].severity).toBe("high");
  });

  /**
   * The case that actually separates the two readings, and the reason the one above does not: when
   * a package's summary and its advisory agree, judging on either gives the same answer. `npm audit`
   * gives a package the worst severity in its whole chain, so a package summarised "critical" on
   * account of a dependency can carry a moderate advisory of its own — and judging on the summary
   * would block on it. Verified by mutation: swapping the check to the summary leaves every other
   * case in this file green.
   */
  it("does not block a moderate advisory under a package summarised worse", () => {
    const verdict = judge(
      report({ parent: { severity: "critical", via: [via("GHSA-moderate-0004", "moderate")] } }),
      []
    );

    expect(verdict.blocking).toEqual([]);
    expect(findings(report({ parent: { severity: "critical", via: [via("GHSA-moderate-0004", "moderate")] } }))).toEqual([]);
  });

  it("counts one advisory once however many packages report it", () => {
    const shared = via("GHSA-shared-0002", "high");

    expect(findings(report({ a: { severity: "high", via: [shared] }, b: { severity: "high", via: [shared] } }))).toHaveLength(1);
  });

  it.each([undefined, null, {}, { vulnerabilities: null }, "not json at all", 42])(
    "treats %p as no findings rather than throwing",
    (input) => {
      expect(() => judge(input, [])).not.toThrow();
      expect(judge(input, []).blocking).toEqual([]);
    }
  );

  /**
   * ...which is only safe because the caller asks this question first. `npm audit` reports an
   * unreachable registry, a missing lockfile or an auth failure as well-formed JSON with an
   * `error` key and no `vulnerabilities`, and exits 0 for the first of those — so "no findings"
   * and "we could not look" are the same value, and the gate has to tell them apart before it
   * judges anything (BP-599 review).
   */
  describe("did the audit actually run", () => {
    it("accepts a report that has both halves of a real answer", () => {
      expect(ranSuccessfully({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } })).toBe(true);
    });

    it.each([
      ["an unreachable registry", { message: "ECONNREFUSED", error: { summary: "", detail: "" } }],
      // The `error` key on its own has to be disqualifying: without this case, removing that check
      // changed nothing, because every other fixture was already rejected for missing a field
      [
        "an error alongside otherwise complete fields",
        { error: { code: "ENOLOCK" }, vulnerabilities: {}, metadata: { dependencies: { prod: 1 } } },
      ],
      ["a missing lockfile", { error: { code: "ENOLOCK", summary: "no lock file" } }],
      ["no vulnerabilities key", { metadata: {} }],
      ["no metadata", { vulnerabilities: {} }],
      ["not an object", "ECONNREFUSED"],
      ["nothing at all", undefined],
    ])("refuses %s", (_name, input) => {
      expect(ranSuccessfully(input)).toBe(false);
    });
  });

  /**
   * This case used to assert the opposite, with a comment claiming that skipping such an entry was
   * safe because it "could not be accepted by id either" — but skipping IS letting through, and a
   * critical with no advisory URL passed the gate in silence. Something unrecognised in a security
   * feed is the last thing that should pass quietly, so it blocks under a synthetic key that no
   * allowlist can hold (BP-599 review).
   */
  it("blocks an enforced advisory carrying no GHSA id, rather than skipping it", () => {
    const verdict = judge(
      report({ p: { severity: "high", via: [{ title: "no url", severity: "high" }, via("GHSA-real-0003", "high")] } }),
      []
    );

    expect(verdict.blocking.map((f) => f.id)).toEqual(["UNIDENTIFIED:p:no url", "GHSA-real-0003"]);
  });

  /**
   * ...and it cannot be silenced by writing the synthetic key into the allowlist. This case used to
   * assert the opposite of its own name — that the entry WAS accepted — leaning on a shipped-list
   * assertion that is vacuously true while the list is empty. The property belongs in the code:
   * `judge` ignores an allowlist entry whose id is not a real advisory id (BP-599 review).
   */
  it("cannot have an unidentified finding accepted", () => {
    const verdict = judge(report({ p: { severity: "critical", via: [{ title: "x", severity: "critical" }] } }), [
      accept({ id: "UNIDENTIFIED:p:x", package: "p" }),
    ]);

    expect(verdict.accepted).toEqual([]);
    expect(verdict.blocking.map((f) => f.id)).toEqual(["UNIDENTIFIED:p:x"]);
  });

  // The control: a real GHSA id in the same position is honoured, so the rule above is about the
  // shape of the id and not about acceptance being broken
  it("still honours a real advisory id in the allowlist", () => {
    const verdict = judge(report({ p: { severity: "critical", via: [via("GHSA-shaped-0010", "critical")] } }), [
      accept({ id: "GHSA-shaped-0010", package: "p" }),
    ]);

    expect(verdict.blocking).toEqual([]);
  });

  // npm has spelled severities in capitals before; a gate that only recognises one casing turns a
  // critical into silence
  it.each(["CRITICAL", "High"])("recognises %s however it is cased", (severity) => {
    const verdict = judge(report({ p: { severity, via: [via("GHSA-cased-0005", severity)] } }), []);

    expect(verdict.blocking.map((f) => f.id)).toEqual(["GHSA-cased-0005"]);
    expect(verdict.blocking[0].severity).toBe(severity.toLowerCase());
  });

  it.each([
    ["a plain package name", "another-package"],
    // `null` is the one that throws on destructuring, which is what the guard is actually for
    ["a null", null],
    ["a number", 7],
  ])("does not throw or report a finding for a via entry that is %s", (_name, entry) => {
    expect(() => findings(report({ p: { severity: "high", via: [entry] } }))).not.toThrow();
    expect(findings(report({ p: { severity: "high", via: [entry] } }))).toEqual([]);
  });
});

/**
 * The guard that exists because the reason was written wrongly twice, one package apart: a careful
 * argument for tolerating something that had a patched version inside a range its parent already
 * declared. npm puts that answer in the report, so the gate refuses the acceptance rather than
 * relying on whoever writes the next one to check (BP-599 review).
 */
describe("an acceptance npm itself contradicts", () => {
  const entry = [accept({ id: "GHSA-fixable-0007", package: "p" })];
  const withFix = (fixAvailable: unknown) =>
    report({ p: { severity: "high", fixAvailable, via: [via("GHSA-fixable-0007", "high")] } });

  it("is refused when npm reports a fix in reach", () => {
    expect(judge(withFix(true), entry).blocking.map((f) => f.id)).toEqual(["GHSA-fixable-0007"]);
  });

  it("is refused when the fix is a minor or patch", () => {
    expect(judge(withFix({ name: "p", version: "1.2.3", isSemVerMajor: false }), entry).blocking).toHaveLength(1);
  });

  /**
   * Only a **confirmed** major escapes. The first version of this guard returned "not bumpable"
   * for anything it did not recognise, so four shapes npm could plausibly emit let an acceptance
   * stand — and the guard exists precisely so that nobody has to trust a judgement about what npm
   * will emit (BP-599 review).
   */
  it.each([
    ["an object with no flag", { name: "p", version: "1.2.3" }],
    ["a stringified false", { isSemVerMajor: "false" }],
    ["a stringified true", { isSemVerMajor: "true" }],
    ["a number", { isSemVerMajor: 1 }],
    ["a bare truthy value", "yes"],
    // Falsy but not one of npm's three ways of saying "no fix" — `!fixAvailable` would have let
    // these back into the permissive branch the guard was inverted to escape
    ["a zero", 0],
    ["an empty string", ""],
  ])("is refused when the fix shape is unrecognised — %s", (_name, shape) => {
    expect(judge(withFix(shape), entry).blocking).toHaveLength(1);
  });

  /**
   * One advisory is reported under every package that pulls it in, and npm can answer differently
   * for each. Merged worst-case, so the order npm happened to list the packages in cannot decide
   * the verdict — which it did before: aaa(fixable) then zzz(no fix) accepted, the reverse blocked.
   */
  it.each([
    ["fixable first", { aaa: true, zzz: false }],
    ["fixable last", { aaa: false, zzz: true }],
  ])("blocks when any package reporting it says a bump would do — %s", (_name, fixes) => {
    const shared = via("GHSA-fixable-0007", "high");
    const multi = report(
      Object.fromEntries(
        Object.entries(fixes).map(([pkg, fixAvailable]) => [pkg, { severity: "high", fixAvailable, via: [shared] }])
      )
    );

    expect(judge(multi, entry).blocking.map((f) => f.id)).toEqual(["GHSA-fixable-0007"]);
  });

  /**
   * A major can break the thing it is protecting, so that one stays arguable — this is the line
   * between "you did not look" and "you looked and it costs a migration".
   */
  it("stands when the only fix needs a major", () => {
    const verdict = judge(withFix({ name: "p", version: "2.0.0", isSemVerMajor: true }), entry);

    expect(verdict.blocking).toEqual([]);
    expect(verdict.accepted.map((f) => f.id)).toEqual(["GHSA-fixable-0007"]);
  });

  it("stands when npm reports no fix at all", () => {
    expect(judge(withFix(false), entry).accepted).toHaveLength(1);
  });
});

/**
 * The trees are separate programs with separate lockfiles, and they are built to diverge — the root
 * pins its MCP SDK through mcp-handler while mcp-server floats. A reason written about one must not
 * excuse the same advisory in the other.
 */
describe("which tree a reason covers", () => {
  const rootOnly = [accept({ id: "GHSA-tree-0008", package: "p", trees: ["."] })];
  const one = report({ p: { severity: "high", via: [via("GHSA-tree-0008", "high")] } });

  it("accepts in the tree it names", () => {
    expect(judge(one, rootOnly, ".").accepted.map((f) => f.id)).toEqual(["GHSA-tree-0008"]);
  });

  it("blocks the same advisory in a tree it does not name", () => {
    expect(judge(one, rootOnly, "mcp-server").blocking.map((f) => f.id)).toEqual(["GHSA-tree-0008"]);
  });

  it("accepts in both when both are named", () => {
    const both = [accept({ id: "GHSA-tree-0008", package: "p", trees: [".", "mcp-server"] })];

    expect(judge(one, both, ".").blocking).toEqual([]);
    expect(judge(one, both, "mcp-server").blocking).toEqual([]);
  });
});

describe("the allowlist this repo ships", () => {
  /**
   * Empty, and asserted as such. Both entries this file has carried turned out to be avoidable
   * bumps; if a future one is genuinely needed this test is the place that says so out loud.
   */
  it("is empty — nothing here is excused today", () => {
    expect(ACCEPTED_ADVISORIES).toEqual([]);
  });

  it("gives every entry a reason, a tree and a way to be deleted", () => {
    for (const entry of ACCEPTED_ADVISORIES) {
      expect(entry.id, `${entry.package} entry has no GHSA id`).toMatch(/^GHSA-[0-9a-z-]+$/i);
      expect(entry.trees.length, `${entry.id} names no tree`).toBeGreaterThan(0);
      // A misspelled tree matches nothing and the advisory blocks — safe, but the entry then reads
      // as authoritative while doing nothing at all
      for (const tree of entry.trees) {
        expect(AUDITED_TREES, `${entry.id} names a tree nothing audits: ${tree}`).toContain(tree);
      }
      expect(entry.why.length, `${entry.id} has no reason`).toBeGreaterThan(40);
      expect(entry.clearedBy.length, `${entry.id} says nothing about what clears it`).toBeGreaterThan(20);
    }
  });

  it("has no duplicate ids, so removing one entry removes the acceptance", () => {
    const ids = ACCEPTED_ADVISORIES.map((a) => a.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
