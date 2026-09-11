import { describe, it, expect } from "vitest";
import { judge, findings, ACCEPTED_ADVISORIES } from "./audit-policy";

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

const report = (vulnerabilities: Record<string, { severity: string; via: unknown[] }>) => ({
  vulnerabilities,
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
    expect(verdict.accepted).toEqual([]);
  });
});

describe("what an acceptance actually accepts", () => {
  const accepted = [{ id: "GHSA-known-0000-0000", package: "fast-uri", why: "unreachable", clearedBy: "a ticket" }];

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
    const verdict = judge(report({}), accepted);

    expect(verdict.stale.map((a) => a.id)).toEqual(["GHSA-known-0000-0000"]);
  });

  // The control: an entry that is still doing work is not reported as stale, so the signal means
  // something when it appears
  it("does not call an acceptance stale while its advisory is still reported", () => {
    const verdict = judge(
      report({ "fast-uri": { severity: "high", via: [via("GHSA-known-0000-0000", "high")] } }),
      accepted
    );

    expect(verdict.stale).toEqual([]);
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

  // A `via` entry with no recognisable id cannot be accepted by id either, so letting it through
  // silently would be a hole; it is skipped, and the package's other advisories still count
  it("skips a via entry carrying no GHSA id", () => {
    const verdict = judge(
      report({ p: { severity: "high", via: [{ title: "no url", severity: "high" }, via("GHSA-real-0003", "high")] } }),
      []
    );

    expect(verdict.blocking.map((f) => f.id)).toEqual(["GHSA-real-0003"]);
  });
});

describe("the allowlist this repo ships", () => {
  it("gives every entry a reason and a way to be deleted", () => {
    for (const entry of ACCEPTED_ADVISORIES) {
      expect(entry.id, `${entry.package} entry has no GHSA id`).toMatch(/^GHSA-[0-9a-z-]+$/i);
      expect(entry.why.length, `${entry.id} has no reason`).toBeGreaterThan(40);
      expect(entry.clearedBy.length, `${entry.id} says nothing about what clears it`).toBeGreaterThan(20);
    }
  });

  it("has no duplicate ids, so removing one entry removes the acceptance", () => {
    const ids = ACCEPTED_ADVISORIES.map((a) => a.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
