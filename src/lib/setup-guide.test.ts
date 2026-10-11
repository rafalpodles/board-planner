import { describe, it, expect } from "vitest";
import { DEFAULT_PROJECT_CATEGORIES, DEFAULT_PROJECT_COLUMNS } from "@/types";
import {
  columnsCustomised,
  fieldsCustomised,
  setupGuideComplete,
  setupGuideSteps,
  type SetupGuideFacts,
} from "./setup-guide";

const BARE: SetupGuideFacts = {
  hasTasks: false,
  grantCount: 1,
  columnsCustomised: false,
  fieldsCustomised: false,
  hasSprint: false,
  repositoryUrl: "",
  hasChannel: false,
  hasWebhook: false,
  mcpConnected: false,
  pmEnabled: false,
  ownAiKey: false,
  workerEnabled: false,
  lockedByInstance: false,
  machine: "none",
  handedOver: false,
  ssoConfigured: false,
  paidPlan: false,
  readerIsInstanceAdmin: false,
  hosted: true,
};

const done = (facts: Partial<SetupGuideFacts>) =>
  Object.fromEntries(setupGuideSteps({ ...BARE, ...facts }).map((s) => [s.id, s.done]));
const ids = (facts: Partial<SetupGuideFacts>) => setupGuideSteps({ ...BARE, ...facts }).map((s) => s.id);

describe("setupGuideSteps", () => {
  it("has nothing done on a bare board", () => {
    expect(Object.values(done({})).every((d) => d === false)).toBe(true);
  });

  it("groups the steps and keeps their order", () => {
    expect(setupGuideSteps(BARE).map((s) => [s.group, s.id])).toEqual([
      ["board", "tasks"],
      ["board", "team"],
      ["board", "columns"],
      ["board", "fields"],
      ["board", "sprint"],
      ["connections", "repository"],
      ["connections", "channel"],
      ["connections", "webhook"],
      ["connections", "mcp"],
      ["agents", "runs"],
      ["agents", "machine"],
      ["agents", "handover"],
    ]);
  });

  it("adds the organisation's steps for an instance admin, and only for one", () => {
    expect(ids({})).not.toContain("sso");
    expect(ids({})).not.toContain("plan");
    expect(ids({})).not.toContain("aiKey");
    expect(ids({})).not.toContain("pm");
    const admin = ids({ readerIsInstanceAdmin: true });
    expect(admin).toEqual(expect.arrayContaining(["pm", "aiKey", "sso", "plan"]));
  });

  it("leaves out single sign-on and the plan on a self-hosted instance, where they are set in the environment", () => {
    const admin = ids({ readerIsInstanceAdmin: true, hosted: false });
    expect(admin).toContain("aiKey");
    expect(admin).not.toContain("sso");
    expect(admin).not.toContain("plan");
  });

  it("counts the team as done only past the owner alone", () => {
    expect(done({ grantCount: 1 }).team).toBe(false);
    expect(done({ grantCount: 2 }).team).toBe(true);
  });

  it("does not take a blank repository for one", () => {
    expect(done({ repositoryUrl: "   " }).repository).toBe(false);
    expect(done({ repositoryUrl: "https://github.com/acme/orbit" }).repository).toBe(true);
  });

  it("lets the instance lock win over the owner's switch", () => {
    expect(done({ workerEnabled: true, lockedByInstance: true }).runs).toBe(false);
    expect(done({ workerEnabled: true }).runs).toBe(true);
  });

  it("is done for a machine only when it is live", () => {
    for (const machine of ["none", "disabled", "stale", "held", "unbound", "paused", "stopped", "failing"] as const) {
      expect(done({ machine }).machine, machine).toBe(false);
    }
    expect(done({ machine: "live" }).machine).toBe(true);
  });

  it.each([
    ["tasks", { hasTasks: true }],
    ["columns", { columnsCustomised: true }],
    ["fields", { fieldsCustomised: true }],
    ["sprint", { hasSprint: true }],
    ["channel", { hasChannel: true }],
    ["webhook", { hasWebhook: true }],
    ["mcp", { mcpConnected: true }],
    ["handover", { handedOver: true }],
  ] as const)("marks %s done from its own fact and no other", (id, facts) => {
    const result = done(facts);
    expect(result[id]).toBe(true);
    expect(Object.entries(result).filter(([k, v]) => v && k !== id)).toEqual([]);
  });

  it.each([
    ["pm", { pmEnabled: true }],
    ["aiKey", { ownAiKey: true }],
    ["sso", { ssoConfigured: true }],
    ["plan", { paidPlan: true }],
  ] as const)("marks the organisation's %s done for an instance admin", (id, facts) => {
    expect(done({ ...facts, readerIsInstanceAdmin: true })[id]).toBe(true);
    expect(done({ readerIsInstanceAdmin: true })[id]).toBe(false);
  });

  describe("locked", () => {
    const locked = (facts: Partial<SetupGuideFacts>) =>
      setupGuideSteps({ ...BARE, workerEnabled: true, lockedByInstance: true, ...facts }).find((s) => s.id === "runs")!
        .locked;

    it("is set for an owner who cannot lift the lock", () => {
      expect(locked({})).toBe(true);
    });
    it("is not set for an instance admin, who can", () => {
      expect(locked({ readerIsInstanceAdmin: true })).toBe(false);
    });
    it("is not set when nothing is locked", () => {
      expect(locked({ lockedByInstance: false })).toBe(false);
    });
  });
});

describe("setupGuideComplete", () => {
  it("needs every step the reader sees to be done", () => {
    const all: SetupGuideFacts = {
      ...BARE,
      hasTasks: true,
      grantCount: 3,
      columnsCustomised: true,
      fieldsCustomised: true,
      hasSprint: true,
      repositoryUrl: "https://github.com/acme/orbit",
      hasChannel: true,
      hasWebhook: true,
      mcpConnected: true,
      workerEnabled: true,
      machine: "live",
      handedOver: true,
    };
    expect(setupGuideComplete(setupGuideSteps(all))).toBe(true);
    expect(setupGuideComplete(setupGuideSteps({ ...all, readerIsInstanceAdmin: true }))).toBe(false);
    expect(setupGuideComplete(setupGuideSteps(BARE))).toBe(false);
  });
});

describe("columnsCustomised", () => {
  const defaults = DEFAULT_PROJECT_COLUMNS.map((c) => ({ ...c }));

  it("is false for a board that stores none, or the defaults as stored", () => {
    expect(columnsCustomised(undefined)).toBe(false);
    expect(columnsCustomised([])).toBe(false);
    expect(columnsCustomised(defaults)).toBe(false);
  });

  it("is true once a column is renamed, re-roled, added or removed", () => {
    expect(columnsCustomised(defaults.map((c, i) => (i === 1 ? { ...c, label: "Ready" } : c)))).toBe(true);
    expect(columnsCustomised(defaults.map((c, i) => (i === 1 ? { ...c, role: "active" } : c)))).toBe(true);
    expect(columnsCustomised([...defaults, { ...defaults[0], id: "extra" }])).toBe(true);
    expect(columnsCustomised(defaults.slice(0, -1))).toBe(true);
  });
});

describe("fieldsCustomised", () => {
  const categories = DEFAULT_PROJECT_CATEGORIES.map((c) => ({ ...c }));

  it("is false for the default categories and no fields", () => {
    expect(fieldsCustomised([], categories)).toBe(false);
    expect(fieldsCustomised(undefined, undefined)).toBe(false);
  });

  it("does not count the fields a new board is seeded with", () => {
    expect(fieldsCustomised([{ name: "Component" }, { name: "Difficulty" }], categories)).toBe(false);
  });

  it("is true with a field of its own, or categories that differ", () => {
    expect(fieldsCustomised([{ name: "Difficulty" }, { name: "Customer" }], categories)).toBe(true);
    expect(fieldsCustomised([], [...categories, { name: "support" }])).toBe(true);
    expect(fieldsCustomised([], categories.map((c, i) => (i === 0 ? { ...c, name: "defect" } : c)))).toBe(true);
  });
});
