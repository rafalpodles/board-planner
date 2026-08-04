import { describe, it, expect } from "vitest";
import { parseProjectWorkerConfig } from "./project-worker-config";

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
