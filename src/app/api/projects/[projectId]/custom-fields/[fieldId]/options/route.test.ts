import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_OPTIONS } from "@/lib/custom-fields";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindOne = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findOne: projectFindOne, findOneAndUpdate: projectFindOneAndUpdate },
}));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));

const { POST } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const DROPDOWN = "6a70afff45d39cd9bc8bb5d3";
const TEXT = "6a70afff45d39cd9bc8bb5d4";

const size = { id: "s", value: "S", color: "#4ade80", order: 0 };
const large = { id: "l", value: "L", color: "#f59e0b", order: 1 };

function fields(options: unknown[] = [size, large]) {
  return [
    { _id: DROPDOWN, name: "Difficulty", fieldType: "dropdown", options },
    { _id: TEXT, name: "Notes", fieldType: "text", options: [] },
  ];
}

const reads = (customFields: unknown[] | null) =>
  projectFindOne.mockReturnValueOnce({ select: () => ({ lean: async () => (customFields ? { customFields } : null) }) });
const writes = (answer: object | null) =>
  projectFindOneAndUpdate.mockReturnValueOnce({ lean: async () => answer });

function post(body: unknown, fieldId = DROPDOWN) {
  return POST(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/custom-fields/${fieldId}/options`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID, fieldId }) }
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
});

describe("POST /api/projects/:projectId/custom-fields/:fieldId/options", () => {
  it("pushes one option onto that field's own array and rewrites nothing else", async () => {
    reads(fields());
    writes({ customFields: fields() });

    const res = await post({ value: " XL ", color: "#112233" });

    expect(res.status).toBe(201);
    const [filter, update, options] = projectFindOneAndUpdate.mock.calls[0];
    expect(Object.keys(update)).toEqual(["$push"]);
    expect(Object.keys(update.$push)).toEqual(["customFields.$.options"]);
    expect(update.$push["customFields.$.options"]).toMatchObject({ value: "XL", color: "#112233", order: 2 });
    expect(update.$push["customFields.$.options"].id).toMatch(/^xl-/);
    expect(options).toEqual({ returnDocument: "before" });
    expect(filter.customFields.$elemMatch._id).toBe(DROPDOWN);
  });

  it("answers with the option and the field as it now reads, the options already there untouched", async () => {
    reads(fields());
    writes({ customFields: fields() });

    const body = await (await post({ value: "XL" })).json();

    expect(body.option).toMatchObject({ value: "XL", order: 2 });
    expect(body.field.options).toEqual([size, large, body.option]);
  });

  it("puts the ceiling and the name in the write's own filter, a bare legacy string included", async () => {
    reads(fields());
    writes({ customFields: fields() });

    await post({ value: "XL" });

    const match = projectFindOneAndUpdate.mock.calls[0][0].customFields.$elemMatch;
    expect(match[`options.${MAX_OPTIONS - 1}`]).toEqual({ $exists: false });
    const sameName = { $regex: "^XL$", $options: "i" };
    expect(match.$nor).toEqual([{ options: { $elemMatch: { value: sameName } } }, { options: { $elemMatch: sameName } }]);
  });

  it("numbers the new option after the ones the field has, legacy strings counted", async () => {
    reads(fields(["Small", "Large", "Huge"]));
    writes({ customFields: fields(["Small", "Large", "Huge"]) });

    await post({ value: "XL" });

    expect(projectFindOneAndUpdate.mock.calls[0][1].$push["customFields.$.options"].order).toBe(3);
  });

  it("records the add in the words the field's own edit uses", async () => {
    reads(fields());
    writes({ customFields: fields() });

    await post({ value: "XL" });

    expect(logProjectAudit).toHaveBeenCalledWith(
      scopedToDefaultOrganisation(),
      PROJECT_ID,
      "u1",
      "settings_updated",
      ["Custom field Difficulty · Options: S, L → S, L, XL"]
    );
  });

  describe("what it refuses before writing anything", () => {
    it.each([
      ["no value", {}, 400, /needs a value/],
      ["a value that is not text", { value: 3 }, 400, /needs a value/],
      ["a blank value", { value: "  " }, 400, /needs a value/],
      ["a value over the limit", { value: "x".repeat(101) }, 400, /100 characters/],
      ["a value with a control character", { value: "a\nb" }, 400, /control characters/],
    ])("%s", async (_name, body, status, error) => {
      const res = await post(body);

      expect(res.status).toBe(status);
      expect((await res.json()).error).toMatch(error);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("a name the field already has, in any case", async () => {
      reads(fields());

      const res = await post({ value: "s" });

      expect(res.status).toBe(409);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("a field that has no options to add to", async () => {
      reads(fields());

      const res = await post({ value: "x" }, TEXT);

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/dropdown or multiselect/);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("a field the project does not have, and an id that is not one", async () => {
      reads(fields());
      expect((await post({ value: "x" }, "6a70afff45d39cd9bc8bb5ff")).status).toBe(404);
      expect((await post({ value: "x" }, "nope")).status).toBe(404);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("a project that is gone", async () => {
      reads(null);

      expect((await post({ value: "x" })).status).toBe(404);
    });
  });

  describe("when the field changes under it", () => {
    it("says the name was taken when that is what the write missed on", async () => {
      reads(fields());
      writes(null);
      reads(fields([size, large, { id: "x", value: "XL", color: "#000000", order: 2 }]));

      const res = await post({ value: "XL" });

      expect(res.status).toBe(409);
      expect(logProjectAudit).not.toHaveBeenCalled();
    });

    it("says it is full when the ceiling is what the write missed on", async () => {
      reads(fields());
      writes(null);
      reads(fields(Array.from({ length: MAX_OPTIONS }, (_, i) => ({ id: `o${i}`, value: `O${i}`, color: "#000000", order: i }))));

      const res = await post({ value: "XL" });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(`${MAX_OPTIONS} options`);
    });

    it("answers 404 when the field was removed after it was read", async () => {
      reads(fields());
      writes(null);
      reads([]);

      expect((await post({ value: "XL" })).status).toBe(404);
    });
  });

  describe("who may", () => {
    it("401s with no credential", async () => {
      getAuthUser.mockResolvedValue(null);

      expect((await post({ value: "XL" })).status).toBe(401);
    });

    it("403s somebody with no access to the project, before reading it", async () => {
      check.mockResolvedValue(false);

      expect((await post({ value: "XL" })).status).toBe(403);
      expect(projectFindOne).not.toHaveBeenCalled();
    });
  });
});
