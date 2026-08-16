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
    const result = parseProjectWorkerConfig({ policy: { model: "sonnet" } }, ["baseBranch"]);

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([
      "baseBranch",
      "model",
    ]);
  });

  // Turning merging off explicitly is a decision, and must not read as inherited afterwards
  it("records a value equal to the default as deliberately set", () => {
    const result = parseProjectWorkerConfig({ policy: { model: "opus" } });

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([
      "model",
    ]);
  });

  it("trims strings", () => {
    const result = parseProjectWorkerConfig({ policy: { baseBranch: "  develop  " } });

    expect((result as { update: Record<string, unknown> }).update["worker.policy.baseBranch"]).toBe(
      "develop"
    );
  });

  describe("refusals", () => {

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

    it("refuses a claimAssignee that is not a user id", () => {
      for (const bad of ["claude", "", 1, true, {}, "not-an-objectid"]) {
        expect(parseProjectWorkerConfig({ claimAssignee: bad })).toMatchObject({ ok: false });
      }
    });

    // Null is how a project says it has nominated nobody, which under claimScope "assigned" means
    // nothing qualifies — a state the settings screen names rather than leaving to be discovered
    it("accepts a user id, and null for nobody", () => {
      expect(parseProjectWorkerConfig({ claimAssignee: "6a70afff45d39cd9bc8bb600" })).toEqual({
        ok: true,
        update: { "worker.claimAssignee": "6a70afff45d39cd9bc8bb600" },
      });
      expect(parseProjectWorkerConfig({ claimAssignee: null })).toEqual({
        ok: true,
        update: { "worker.claimAssignee": null },
      });
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
    const result = parseProjectWorkerConfig({ reset: ["model"] }, ["model", "baseBranch"]);

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([
      "baseBranch",
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
    const result = parseProjectWorkerConfig({ reset: ["model", "model"] }, [
      "model",
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
      { reset: ["baseBranch"], policy: { model: "sonnet" } },
      ["model"]
    );
    const update = (result as { update: Record<string, unknown> }).update;

    expect(update["worker.policyOverrides"]).toEqual(["model"]);
    expect(update["worker.policy.model"]).toBe("sonnet");
  });

  // Otherwise the outcome would depend on which branch ran last
  it("refuses to set and reset the same field in one request", () => {
    expect(
      parseProjectWorkerConfig({ reset: ["model"], policy: { model: "sonnet" } })
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
// The rule that lived here — autoMerge may not outlive the review gate — is retired with both
// fields. Merging is now a Merge step in a composition, and whether the change was reviewed is read
// off the same sequence: see "refuses a review that ran before the last thing that wrote" in
// agent-rules.test.ts.
