import { describe, it, expect } from "vitest";
import { parseProjectSetup, MAX_SETUP_PEOPLE } from "./project-setup";
import { PROJECT_ICONS } from "@/types";

const BOARD = [
  { label: "Backlog", role: "backlog" },
  { label: "Doing", role: "active" },
  { label: "Done", role: "done" },
];
const ID = "64b0000000000000000000a1";

function ok(body: Record<string, unknown>) {
  const parsed = parseProjectSetup(body);
  if (!parsed.ok) throw new Error(`refused: ${parsed.error}`);
  return parsed.value;
}
function refusal(body: Record<string, unknown>) {
  const parsed = parseProjectSetup(body);
  if (parsed.ok) throw new Error("accepted");
  return parsed.error;
}

describe("parseProjectSetup", () => {
  it("accepts a request with no setup at all, so a plain create is unchanged", () => {
    expect(ok({})).toEqual({ access: [] });
  });

  describe("columns", () => {
    it("gives every column an id from its label, an order from its place, and a default colour", () => {
      expect(ok({ columns: BOARD }).columns).toEqual([
        { id: "backlog", label: "Backlog", color: "#6b7280", role: "backlog", order: 0, triggersPmReview: false },
        { id: "doing", label: "Doing", color: "#6b7280", role: "active", order: 1, triggersPmReview: false },
        { id: "done", label: "Done", color: "#6b7280", role: "done", order: 2, triggersPmReview: false },
      ]);
    });

    it("suffixes the id of a label that repeats, rather than refusing it", () => {
      const ids = ok({
        columns: [...BOARD, { label: "Done", role: "review" }],
      }).columns?.map((c) => c.id);
      expect(ids).toEqual(["backlog", "doing", "done", "done_2"]);
    });

    it("lets one review column hand over to the PM", () => {
      const columns = ok({
        columns: [...BOARD, { label: "Check A", role: "review", triggersPmReview: true }],
      }).columns!;
      expect(columns.filter((c) => c.triggersPmReview).map((c) => c.id)).toEqual(["check_a"]);
    });

    it("refuses a second hand-over column and a hand-over on a column that is not a review column", () => {
      expect(
        refusal({
          columns: [
            ...BOARD,
            { label: "Check A", role: "review", triggersPmReview: true },
            { label: "Check B", role: "review", triggersPmReview: true },
          ],
        })
      ).toMatch(/Only one column/);
      expect(
        refusal({ columns: [{ label: "Doing", role: "active", triggersPmReview: true }, { label: "Done", role: "done" }] })
      ).toMatch(/Awaiting review/);
    });

    it("keeps the colour it was given, and refuses more columns than a board may have", () => {
      expect(ok({ columns: [{ label: "Doing", role: "active", color: "#123456" }, { label: "Done", role: "done" }] }).columns![0].color).toBe("#123456");
      const tooMany = [
        { label: "Doing", role: "active" },
        { label: "Done", role: "done" },
        ...Array.from({ length: 11 }, (_, i) => ({ label: `Extra ${i}`, role: "backlog" })),
      ];
      expect(tooMany).toHaveLength(13);
      expect(refusal({ columns: tooMany })).toMatch(/1-12/);
    });

    it.each([
      ["a board with no Done column", [{ label: "Doing", role: "active" }], /Done/],
      ["a board with no In progress column", [{ label: "Done", role: "done" }], /In progress/],
      ["a role nobody defined", [{ label: "Doing", role: "active" }, { label: "Done", role: "finished" }], /role must be one of/],
      ["an empty label", [{ label: "  ", role: "active" }, { label: "Done", role: "done" }], /1-40/],
      ["a label that is only punctuation", [{ label: "!!!", role: "active" }, { label: "Done", role: "done" }], /empty id/],
      ["no columns", [], /1-12/],
      ["a column that is not an object", ["Doing", "Done"], /objects/],
    ])("refuses %s", (_label, columns, message) => {
      expect(refusal({ columns })).toMatch(message);
    });
  });

  it("reads null as a field that was not sent", () => {
    expect(ok({ icon: null, columns: null, categories: null, components: null, labels: null, repositoryUrl: null, pm: null, access: null })).toEqual({
      access: [],
    });
  });

  describe("categories", () => {
    it("takes an empty list, which is how a board starts with none", () => {
      expect(ok({ categories: [] }).categories).toEqual([]);
    });

    it("trims names and gives a colour to one that has none", () => {
      expect(ok({ categories: [{ name: "  bug " }] }).categories).toEqual([{ name: "bug", color: "#3b82f6" }]);
    });

    it("refuses more categories than a board may have", () => {
      const many = Array.from({ length: 51 }, (_, i) => ({ name: `c${i}` }));
      expect(refusal({ categories: many })).toMatch(/at most 50/);
    });

    it.each([
      ["a name listed twice in another case", [{ name: "Bug" }, { name: "bug" }]],
      ["a blank name", [{ name: "  " }]],
      ["a name over the limit", [{ name: "x".repeat(51) }]],
      ["a name with a control character", [{ name: "bug\nfix" }]],
      ["a category with no name", [{ color: "#fff" }]],
    ])("refuses %s", (_label, categories) => {
      expect(refusal({ categories })).not.toBe("");
    });
  });

  describe("components and labels", () => {
    it("turns names into options with ids and keeps their order", () => {
      const options = ok({ components: ["api", "web"] }).components!;
      expect(options.map((o) => [o.value, o.order])).toEqual([["api", 0], ["web", 1]]);
      expect(new Set(options.map((o) => o.id)).size).toBe(2);
    });

    it("reads a label from a bare string or from a name with a colour", () => {
      const labels = ok({ labels: ["Needs docs", { name: "Security", color: "#ef4444" }] }).labels!;
      expect(labels.map((l) => [l.value, l.color])[1]).toEqual(["Security", "#ef4444"]);
      expect(labels[0].value).toBe("Needs docs");
    });

    it("refuses the same name twice, in any case", () => {
      expect(refusal({ components: ["API", "api"] })).toMatch(/unique/);
    });

    it("refuses an entry that is neither a string nor a named object", () => {
      expect(refusal({ labels: [42] })).toMatch(/needs a name/);
    });

    it("refuses what is not a list", () => {
      expect(refusal({ components: "api" })).toMatch(/array/);
    });
  });

  describe("icon, repository and PM", () => {
    it("accepts an icon from the picker, and none at all", () => {
      expect(ok({ icon: PROJECT_ICONS[0] }).icon).toBe(PROJECT_ICONS[0]);
      expect(ok({ icon: "" }).icon).toBe("");
    });

    it("refuses an icon the picker does not offer", () => {
      expect(refusal({ icon: "<script>" })).toMatch(/icon/);
    });

    it("trims the repository address and refuses one that is not text", () => {
      expect(ok({ repositoryUrl: " https://github.com/acme/web " }).repositoryUrl).toBe("https://github.com/acme/web");
      expect(refusal({ repositoryUrl: { url: "x" } })).toMatch(/string/);
      expect(refusal({ repositoryUrl: "x".repeat(2049) })).toMatch(/valid address/);
      expect(refusal({ repositoryUrl: "https://example.com/a\nb" })).toMatch(/valid address/);
    });

    it("keeps whether the PM agent is on, and refuses anything but a boolean", () => {
      expect(ok({ pm: { enabled: true } }).pmEnabled).toBe(true);
      expect(ok({ pm: {} }).pmEnabled).toBeUndefined();
      expect(refusal({ pm: { enabled: "yes" } })).toMatch(/true or false/);
      expect(refusal({ pm: true })).toMatch(/true or false/);
      expect(ok({ pm: { enabled: false } }).pmEnabled).toBe(false);
    });
  });

  describe("access", () => {
    it("reads each person with a role of owner or member", () => {
      expect(ok({ access: [{ userId: ID, relation: "owner" }] }).access).toEqual([{ userId: ID, relation: "owner" }]);
    });

    it.each([
      ["an id that is not an ObjectId", [{ userId: "anna", relation: "member" }]],
      ["a role that is not offered", [{ userId: ID, relation: "viewer" }]],
      ["the same person in two roles", [{ userId: ID, relation: "member" }, { userId: ID.toUpperCase().replace("64B", "64b"), relation: "owner" }]],
    ])("refuses %s", (_label, access) => {
      expect(refusal({ access })).not.toBe("");
    });

    it("refuses a list longer than a wizard is meant to carry", () => {
      const access = Array.from({ length: MAX_SETUP_PEOPLE + 1 }, (_, i) => ({
        userId: i.toString(16).padStart(24, "0"),
        relation: "member",
      }));
      expect(refusal({ access })).toMatch(String(MAX_SETUP_PEOPLE));
    });
  });
});
