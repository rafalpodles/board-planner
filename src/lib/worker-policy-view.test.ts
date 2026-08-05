import { describe, it, expect } from "vitest";
import { workerPolicyRows, projectPolicyRows } from "./worker-policy-view";
import { PROJECT_POLICY_DEFAULTS, WORKER_POLICY_DEFAULTS } from "./worker-policy";

function view(overrides: {
  policy?: Record<string, unknown>;
  policyOverrides?: string[];
}) {
  return projectPolicyRows({
    policy: { ...PROJECT_POLICY_DEFAULTS, ...(overrides.policy ?? {}) },
    policyOverrides: overrides.policyOverrides ?? [],
  } as never);
}

function row(rows: ReturnType<typeof projectPolicyRows>, field: string) {
  return rows.find((r) => r.field === field)!;
}

describe("policyRows", () => {
  it("covers every policy field, in a stable order", () => {
    expect(view({}).map((r) => r.field)).toEqual(Object.keys(PROJECT_POLICY_DEFAULTS));
  });

  it("marks a field nobody set as inherited", () => {
    expect(row(view({}), "model").overridden).toBe(false);
  });

  it("marks a field the operator set as overridden", () => {
    const rows = view({ policy: { model: "haiku" }, policyOverrides: ["model"] });

    expect(row(rows, "model")).toMatchObject({ value: "haiku", overridden: true });
  });

  // The whole reason the override list exists: a stored 400 and a chosen 400 are the same bytes.
  it("marks a pinned field as overridden even though it equals the default", () => {
    const rows = view({ policyOverrides: ["maxDiffLines"] });

    expect(row(rows, "maxDiffLines")).toMatchObject({ value: "400", overridden: true });
  });

  // An inherited field will run under whatever the default becomes, not under the copy that was
  // materialised into the document when it was created.
  it("shows the default for an inherited field, not the stored copy", () => {
    const rows = view({ policy: { maxDiffLines: 999 } });

    expect(row(rows, "maxDiffLines").value).toBe("400");
  });

  it("always reports the default alongside, so the UI can show what would apply", () => {
    const rows = view({ policy: { model: "haiku" }, policyOverrides: ["model"] });

    expect(row(rows, "model").defaultValue).toBe("opus");
  });

  it("renders millisecond fields as seconds, which is how an operator reads them", () => {
    expect(row(view({}), "taskTimeoutMs").value).toBe("1800s");
  });

  // The split itself: how long a task may take describes the work, how often a machine asks
  // describes the machine. Neither list should be able to show the other's field.
  it("keeps machine settings out of the project's rows, and work settings out of the machine's", () => {
    const projectFields = view({}).map((r) => r.field);
    const workerFields = workerPolicyRows({ policy: {}, policyOverrides: [] }).map((r) => r.field);

    expect(projectFields).toContain("taskTimeoutMs");
    expect(projectFields).not.toContain("pollIntervalMs");
    expect(workerFields).toEqual(["pollIntervalMs"]);
  });

  it("renders the machine's own interval as seconds too", () => {
    expect(workerPolicyRows({ policy: {}, policyOverrides: [] })[0].value).toBe("30s");
  });

  it("survives a worker with no override list recorded at all", () => {
    expect(projectPolicyRows({ policy: PROJECT_POLICY_DEFAULTS, policyOverrides: undefined } as never)).toHaveLength(
      Object.keys(PROJECT_POLICY_DEFAULTS).length
    );
  });

  it("shows an em dash rather than an empty cell for a missing value", () => {
    const rows = view({ policy: { model: "" }, policyOverrides: ["model"] });

    expect(row(rows, "model").value).toBe("—");
  });
});

describe("boolean policy fields", () => {
  // "false" is not a value an operator can read at a glance, and an empty cell would look like a
  // missing setting rather than a deliberate off.
  it("renders a boolean as on or off, never as a raw value", () => {
    expect(row(view({}), "autoMerge").value).toBe("off");
    expect(row(view({ policy: { autoMerge: true }, policyOverrides: ["autoMerge"] }), "autoMerge").value)
      .toBe("on");
  });

  it("defaults autoMerge to off, so an unconfigured worker never merges", () => {
    expect(row(view({}), "autoMerge")).toMatchObject({ value: "off", overridden: false });
  });

  // The case the override list exists for: turning it off explicitly must not read as "inherited"
  it("marks autoMerge explicitly set to off as overridden", () => {
    const r = row(view({ policy: { autoMerge: false }, policyOverrides: ["autoMerge"] }), "autoMerge");

    expect(r).toMatchObject({ value: "off", overridden: true });
  });
});
