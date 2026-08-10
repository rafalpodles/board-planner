import { describe, it, expect } from "vitest";
import { parseProjectWorkerConfig } from "./project-worker-config";
import { CLAIM_SCOPES } from "@/lib/worker-policy";

describe("parseProjectWorkerConfig", () => {
  it("enables workers for the project", () => {
    expect(parseProjectWorkerConfig({ enabled: true })).toEqual({
      ok: true,
      update: { "worker.enabled": true },
    });
  });

  // A partial patch that replaced `worker` wholesale would reset every field it did not mention
  it("writes dotted paths so an untouched field survives", () => {
    const result = parseProjectWorkerConfig({ policy: { baseBranch: "develop" } });

    expect(result).toMatchObject({
      ok: true,
      update: { "worker.policy.baseBranch": "develop" },
    });
    expect(Object.keys((result as { update: object }).update)).not.toContain("worker");
  });

  it("records which fields an operator set, merging with what was set before", () => {
    const result = parseProjectWorkerConfig({ policy: { autoMerge: true } }, ["baseBranch"]);

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([
      "baseBranch",
      "autoMerge",
    ]);
  });

  // Turning merging off explicitly is a decision, and must not read as inherited afterwards
  it("records a value equal to the default as deliberately set", () => {
    const result = parseProjectWorkerConfig({ policy: { autoMerge: false } });

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([
      "autoMerge",
    ]);
  });

  it("trims strings", () => {
    const result = parseProjectWorkerConfig({ policy: { baseBranch: "  develop  " } });

    expect((result as { update: Record<string, unknown> }).update["worker.policy.baseBranch"]).toBe(
      "develop"
    );
  });

  describe("refusals", () => {
    // "false" is truthy in JavaScript; a project that starts merging because someone sent the
    // string is exactly the failure this prevents.
    it("refuses a non-boolean autoMerge", () => {
      for (const bad of ["true", "false", 1, 0, null]) {
        expect(parseProjectWorkerConfig({ policy: { autoMerge: bad } })).toMatchObject({
          ok: false,
        });
      }
    });

    // A closed set, so anything else stores a scope claimNextTask matches against nothing — and a
    // worker that claims nothing is indistinguishable from a project with no approved work
    it("refuses a claimScope outside the enumerated set", () => {
      for (const bad of ["Assigned", "all", "", "none", true, 1, null]) {
        expect(parseProjectWorkerConfig({ policy: { claimScope: bad } })).toMatchObject({
          ok: false,
        });
      }
    });

    it("accepts each scope the claim can actually read", () => {
      for (const scope of CLAIM_SCOPES) {
        expect(parseProjectWorkerConfig({ policy: { claimScope: scope } })).toEqual({
          ok: true,
          update: {
            "worker.policy.claimScope": scope,
            "worker.policyOverrides": ["claimScope"],
          },
        });
      }
    });

    it("refuses a non-boolean enabled", () => {
      expect(parseProjectWorkerConfig({ enabled: "yes" })).toMatchObject({ ok: false });
    });

    it("refuses an empty or non-string branch", () => {
      expect(parseProjectWorkerConfig({ policy: { baseBranch: "  " } })).toMatchObject({ ok: false });
      expect(parseProjectWorkerConfig({ policy: { baseBranch: 7 } })).toMatchObject({ ok: false });
    });

    it("refuses a non-positive-integer limit", () => {
      for (const bad of [0, -1, 1.5, "400", null]) {
        expect(parseProjectWorkerConfig({ policy: { maxDiffLines: bad } })).toMatchObject({
          ok: false,
        });
      }
    });

    // Machine-level settings must not be reachable through the project, or one project's admin
    // would be changing how someone else's laptop behaves.
    it("refuses a field that belongs to the worker, not the project", () => {
      expect(parseProjectWorkerConfig({ policy: { pollIntervalMs: 5000 } })).toEqual({
        ok: false,
        error: "pollIntervalMs is not a worker policy field",
      });
    });

    it("refuses an unknown field rather than storing it", () => {
      expect(parseProjectWorkerConfig({ policy: { nonsense: 1 } })).toMatchObject({ ok: false });
    });

    it("refuses a body that is not an object", () => {
      for (const bad of [null, [], "worker", 3]) {
        expect(parseProjectWorkerConfig(bad)).toMatchObject({ ok: false });
      }
    });

    it("refuses an empty patch rather than issuing a no-op write", () => {
      expect(parseProjectWorkerConfig({})).toMatchObject({ ok: false });
    });
  });
});

// Without this a field touched once could never follow the default again: policyOverrides only
// ever grew, and the UI showed "set" with no route back.
describe("resetting a field to the default", () => {
  it("removes the field from the override list", () => {
    const result = parseProjectWorkerConfig({ reset: ["autoMerge"] }, ["autoMerge", "model"]);

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([
      "model",
    ]);
  });

  // The stored copy goes back too, so the document never holds a value nothing resolves against
  it("puts the stored value back to the default", () => {
    const result = parseProjectWorkerConfig({ reset: ["maxDiffLines"] }, ["maxDiffLines"]);

    expect((result as { update: Record<string, unknown> }).update["worker.policy.maxDiffLines"]).toBe(
      400
    );
  });

  it("resets several fields at once", () => {
    const result = parseProjectWorkerConfig({ reset: ["autoMerge", "model"] }, [
      "autoMerge",
      "model",
      "baseBranch",
    ]);

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([
      "baseBranch",
    ]);
  });

  it("is harmless on a field nobody had pinned", () => {
    const result = parseProjectWorkerConfig({ reset: ["model"] }, []);

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([]);
  });

  it("can reset one field while setting another", () => {
    const result = parseProjectWorkerConfig(
      { reset: ["model"], policy: { autoMerge: true } },
      ["model"]
    );
    const update = (result as { update: Record<string, unknown> }).update;

    expect(update["worker.policyOverrides"]).toEqual(["autoMerge"]);
    expect(update["worker.policy.autoMerge"]).toBe(true);
  });

  // Otherwise the outcome would depend on which branch ran last
  it("refuses to set and reset the same field in one request", () => {
    expect(
      parseProjectWorkerConfig({ reset: ["autoMerge"], policy: { autoMerge: true } })
    ).toMatchObject({ ok: false });
  });

  it("refuses a field that is not a policy field, or a reset that is not an array", () => {
    expect(parseProjectWorkerConfig({ reset: ["pollIntervalMs"] })).toMatchObject({ ok: false });
    expect(parseProjectWorkerConfig({ reset: "model" })).toMatchObject({ ok: false });
    expect(parseProjectWorkerConfig({ reset: [7] })).toMatchObject({ ok: false });
  });
});

// The rule no per-field validator could hold: every field is checked in isolation, so nothing
// stopped a project from merging without review — the one safety property worker/README.md
// asserts outright. It has to be judged on the resulting state, because a partial patch cannot be
// read on its own: setting autoMerge alone is fine or fatal depending on a field it never mentions.
describe("autoMerge cannot outlive the review gate", () => {
  it("refuses the pair in one request", () => {
    const result = parseProjectWorkerConfig({ policy: { autoMerge: true, reviewGate: false } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/merge unreviewed/);
  });

  it("refuses turning autoMerge on when review is already off in the stored policy", () => {
    const result = parseProjectWorkerConfig({ policy: { autoMerge: true } }, [], {
      reviewGate: false,
    });

    expect(result.ok).toBe(false);
  });

  it("refuses turning review off when autoMerge is already on in the stored policy", () => {
    const result = parseProjectWorkerConfig({ policy: { reviewGate: false } }, [], {
      autoMerge: true,
    });

    expect(result.ok).toBe(false);
  });

  it("allows turning review off on a project that does not merge", () => {
    const result = parseProjectWorkerConfig({ policy: { reviewGate: false } }, [], {
      autoMerge: false,
    });

    expect(result.ok).toBe(true);
  });

  it("allows both on together", () => {
    const result = parseProjectWorkerConfig({ policy: { autoMerge: true, reviewGate: true } });

    expect(result.ok).toBe(true);
  });

  // Resetting is the other way to reach the pair, and it lands on the default rather than on
  // whatever was stored
  it("refuses a reset that would leave autoMerge on with review off", () => {
    const result = parseProjectWorkerConfig({ policy: { reviewGate: false }, reset: ["autoMerge"] }, [], {
      autoMerge: true,
    });

    // autoMerge resets to its default of false, so this pair is safe
    expect(result.ok).toBe(true);
  });
});
