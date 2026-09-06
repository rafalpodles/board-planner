import { describe, it, expect } from "vitest";
import { parseProjectWorkerConfig } from "./project-worker-config";

describe("parseProjectWorkerConfig", () => {
  it("enables workers for the project", () => {
    expect(parseProjectWorkerConfig({ enabled: true })).toEqual({
      ok: true,
      update: { "worker.enabled": true },
    });
  });

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

    it("refuses claimScope, which is no longer a recognised field", () => {
      expect(parseProjectWorkerConfig({ policy: { claimScope: "any" } })).toEqual({
        ok: false,
        error: "claimScope is not a worker policy field",
      });
    });

    it("ignores a claimAssignee, which no longer routes anything", () => {
      expect(parseProjectWorkerConfig({ claimAssignee: "6a70afff45d39cd9bc8bb600" })).toEqual({
        ok: false,
        error: "worker had nothing to update",
      });
    });

    it("refuses a non-boolean enabled", () => {
      expect(parseProjectWorkerConfig({ enabled: "yes" })).toMatchObject({ ok: false });
    });

    it("refuses an empty or non-string branch", () => {
      expect(parseProjectWorkerConfig({ policy: { baseBranch: "  " } })).toMatchObject({ ok: false });
      expect(parseProjectWorkerConfig({ policy: { baseBranch: 7 } })).toMatchObject({ ok: false });
    });

    it.each([
      "--output=/tmp/pwned",
      "-o/tmp/pwned",
      ".hidden",
      "main..evil",
      "main//evil",
      "release/",
      "wip.lock",
      "main; touch /tmp/pwned",
      "main branch",
      "refs/heads/main~1^{}",
    ])("refuses a baseBranch git would not read as a ref: %j", (baseBranch) => {
      expect(parseProjectWorkerConfig({ policy: { baseBranch } })).toEqual({
        ok: false,
        error: "baseBranch must be a git branch name",
      });
    });

    it.each(["main", "develop", "release/1.2", "v1.0", "feature/BP-327_fix"])(
      "accepts a baseBranch that is a branch name: %j",
      (baseBranch) => {
        expect(parseProjectWorkerConfig({ policy: { baseBranch } })).toMatchObject({ ok: true });
      }
    );

    it.each(["model", "fallbackModel", "reviewModel"])(
      "refuses an option-shaped %s",
      (field) => {
        expect(
          parseProjectWorkerConfig({ policy: { [field]: "--dangerously-skip-permissions" } })
        ).toEqual({ ok: false, error: `${field} must be a model name` });
      }
    );

    it.each(["opus", "sonnet", "claude-opus-5", "moonshotai/kimi-k2.6", "us.anthropic.claude-v2:1"])(
      "accepts a model name the CLI would take: %j",
      (model) => {
        expect(parseProjectWorkerConfig({ policy: { model } })).toMatchObject({ ok: true });
      }
    );

    it("refuses a non-positive-integer limit", () => {
      for (const bad of [0, -1, 1.5, "400", null]) {
        expect(parseProjectWorkerConfig({ policy: { maxDiffLines: bad } })).toMatchObject({
          ok: false,
        });
      }
    });

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

describe("resetting a field to the default", () => {
  it("removes the field from the override list", () => {
    const result = parseProjectWorkerConfig({ reset: ["model"] }, ["model", "baseBranch"]);

    expect((result as { update: Record<string, unknown> }).update["worker.policyOverrides"]).toEqual([
      "baseBranch",
    ]);
  });

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

