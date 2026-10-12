import { describe, it, expect } from "vitest";
import {
  DEFAULT_COLUMNS,
  SIMPLE_COLUMNS,
  basicsProblem,
  buildPayload,
  columnsOf,
  initialState,
  roleSummary,
  workflowProblem,
  type WizardState,
} from "./wizard-model";
import { parseProjectSetup } from "@/lib/project-setup";

function filled(patch: Partial<WizardState> = {}): WizardState {
  return { ...initialState(), name: "Orbit", key: "orb", ...patch };
}

describe("buildPayload", () => {
  it("sends only the basics for a project nobody customised, as the old form did", () => {
    const payload = buildPayload(filled({ description: " Launch control " }));

    expect(Object.keys(payload).sort()).toEqual(["description", "icon", "key", "name"]);
    expect(payload).toMatchObject({ name: "Orbit", key: "ORB", description: "Launch control" });
  });

  it("sends columns once the preset is not the default one", () => {
    const simple = buildPayload(filled({ preset: "simple" }));
    const custom = buildPayload(
      filled({ preset: "custom", customColumns: [{ label: " Doing ", role: "active", color: "#111111", triggersPmReview: false }] })
    );

    expect(simple.columns?.map((c) => c.label)).toEqual(["Backlog", "To Do", "In Progress", "Done"]);
    expect(custom.columns).toEqual([{ label: "Doing", role: "active", color: "#111111", triggersPmReview: false }]);
  });

  it("tells the three category choices apart: keep, none, and a list", () => {
    const base = initialState().categories;

    expect(buildPayload(filled()).categories).toBeUndefined();
    expect(buildPayload(filled({ categories: { ...base, mode: "empty" } })).categories).toEqual([]);
    expect(
      buildPayload(filled({ categories: { mode: "custom", items: [{ name: "spike", color: "#3b82f6" }] } })).categories
    ).toEqual([{ name: "spike", color: "#3b82f6" }]);
  });

  it("drops components and labels that were switched to custom and left empty", () => {
    const payload = buildPayload(
      filled({ components: { mode: "custom", items: [] }, labels: { mode: "custom", items: ["Security"] } })
    );

    expect(payload.components).toBeUndefined();
    expect(payload.labels).toEqual(["Security"]);
  });

  it("does not send what a switch back to empty left behind in the list", () => {
    const payload = buildPayload(filled({ components: { mode: "empty", items: ["api"] } }));

    expect(payload.components).toBeUndefined();
  });

  it("sends the repository, the PM switch and the people only when they were set", () => {
    const payload = buildPayload(
      filled({
        repositoryUrl: " https://github.com/acme/orbit ",
        pmEnabled: true,
        people: [{ person: { _id: "u1", username: "anna", fullName: "Anna K" }, relation: "owner" }],
      })
    );

    expect(payload.repositoryUrl).toBe("https://github.com/acme/orbit");
    expect(payload.pm).toEqual({ enabled: true });
    expect(payload.access).toEqual([{ userId: "u1", relation: "owner" }]);
  });

  // The client and the server judge the same board; this is the seam between them
  it("builds a payload the server's parser accepts, for every preset", () => {
    for (const preset of ["default", "simple", "custom"] as const) {
      const payload = buildPayload(
        filled({
          preset,
          components: { mode: "custom", items: ["api", "web"] },
          labels: { mode: "custom", items: ["Security"] },
          categories: { mode: "custom", items: [{ name: "spike", color: "#3b82f6" }] },
        })
      );

      const parsed = parseProjectSetup(payload as unknown as Record<string, unknown>);

      expect(parsed.ok, preset).toBe(true);
    }
  });
});

describe("workflowProblem", () => {
  it("has nothing to say about the presets", () => {
    expect(workflowProblem(filled({ preset: "default" }))).toBeNull();
    expect(workflowProblem(filled({ preset: "simple" }))).toBeNull();
  });

  it("names the role a custom board is missing, in the words the server uses", () => {
    const withoutDone = filled({
      preset: "custom",
      customColumns: SIMPLE_COLUMNS.filter((c) => c.role !== "done"),
    });
    const withoutActive = filled({
      preset: "custom",
      customColumns: SIMPLE_COLUMNS.filter((c) => c.role !== "active"),
    });

    expect(workflowProblem(withoutDone)).toMatch(/needs a column meaning Done/);
    expect(workflowProblem(withoutActive)).toMatch(/needs a column meaning In progress/);
  });

  it("refuses a blank column name and a board with too many columns", () => {
    const blank = filled({ preset: "custom", customColumns: [...SIMPLE_COLUMNS, { ...SIMPLE_COLUMNS[0], label: " " }] });
    const many = filled({
      preset: "custom",
      customColumns: Array.from({ length: 13 }, (_, i) => ({ ...SIMPLE_COLUMNS[3], label: `Done ${i}` })),
    });

    expect(workflowProblem(blank)).toMatch(/1-40/);
    expect(workflowProblem(many)).toMatch(/1-12/);
  });
});

describe("basicsProblem", () => {
  it("wants a name and a valid key that no board holds", () => {
    expect(basicsProblem(filled({ name: "  " }), [])).toMatch(/name/);
    expect(basicsProblem(filled({ key: "" }), [])).toMatch(/key/);
    expect(basicsProblem(filled({ key: "1X" }), [])).toMatch(/starts with a letter/);
    expect(basicsProblem(filled({ key: "orb" }), ["ORB"])).toMatch(/already used/);
    expect(basicsProblem(filled(), ["BP"])).toBeNull();
  });
});

describe("roleSummary", () => {
  it("lists the columns of each role, and leaves Blocked out when nothing is blocked", () => {
    const rows = roleSummary(DEFAULT_COLUMNS);

    expect(rows.map((r) => r.role)).toEqual(["backlog", "approved", "active", "review", "done"]);
    expect(rows.find((r) => r.role === "review")?.columns).toEqual([
      "In Review",
      "Needs Human Review",
      "Ready to Test",
    ]);
  });

  it("shows Blocked once a column carries it", () => {
    const rows = roleSummary([...SIMPLE_COLUMNS, { label: "Parked", role: "blocked", color: "#000", triggersPmReview: false }]);

    expect(rows.find((r) => r.role === "blocked")?.columns).toEqual(["Parked"]);
  });
});

describe("columnsOf", () => {
  it("follows the chosen preset", () => {
    expect(columnsOf(filled({ preset: "default" }))).toBe(DEFAULT_COLUMNS);
    expect(columnsOf(filled({ preset: "simple" }))).toBe(SIMPLE_COLUMNS);
  });
});
