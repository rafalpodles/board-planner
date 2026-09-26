import { describe, it, expect, vi, beforeEach } from "vitest";

const MAX_FIELDS = 50;

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const projectExists = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findById: projectFindById, findOneAndUpdate: projectFindOneAndUpdate, exists: projectExists },
}));

const { GET, POST } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";

function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/projects/p1/custom-fields", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

type Field = {
  name: string;
  fieldType: string;
  options?: unknown[];
  required?: boolean;
  order?: number;
  showOnCard?: boolean;
  showInList?: boolean;
  filterable?: boolean;
  archived?: boolean;
};

let doc: { customFields: Field[] };

/** A project with the given field names already defined. */
function project(names: string[] = []) {
  doc = { customFields: names.map((name, i) => ({ name, fieldType: "text", order: i })) };
  projectFindById.mockResolvedValue(doc);
  // The add is an atomic $push with the ceiling in its filter, so the stub applies the write the
  // way the database would — including refusing it once the array is full.
  projectFindOneAndUpdate.mockImplementation(
    async (filter: Record<string, unknown>, update: { $push: { customFields: Field } }) => {
      const full = doc.customFields.length >= MAX_FIELDS;
      if (`customFields.${MAX_FIELDS - 1}` in filter && full) return null;
      doc.customFields = [...doc.customFields, update.$push.customFields];
      return doc;
    }
  );
  return doc;
}

/** A project already holding its ceiling of custom fields. */
function projectAtTheCeiling() {
  return project(Array.from({ length: MAX_FIELDS }, (_, i) => `f${i}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  // The ceiling-miss path re-checks this to tell "full" from "deleted out from under the
  // request" apart (review) — true by default, since every existing scenario's project is there.
  projectExists.mockResolvedValue(true);
  project([]);
});

describe("GET /api/projects/:projectId/custom-fields", () => {
  it("404s when the project is gone", async () => {
    projectFindById.mockResolvedValue(null);

    const res = await GET(request("GET"), ctx());

    expect(res.status).toBe(404);
  });

  it("returns the project's fields", async () => {
    project(["Points"]);

    const res = await GET(request("GET"), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(doc.customFields);
  });
});

describe("POST /api/projects/:projectId/custom-fields", () => {
  const body = { name: "Points", fieldType: "number" };

  it("refuses a blank name", async () => {
    const res = await POST(request("POST", { ...body, name: "   " }), ctx());
    expect(res.status).toBe(400);
  });

  it("refuses a name over the length limit", async () => {
    const res = await POST(request("POST", { ...body, name: "n".repeat(101) }), ctx());
    expect(res.status).toBe(400);
  });

  it("refuses an unknown field type", async () => {
    const res = await POST(request("POST", { ...body, fieldType: "nope" }), ctx());
    expect(res.status).toBe(400);
  });

  it("refuses an option field with no options", async () => {
    const res = await POST(request("POST", { name: "Size", fieldType: "dropdown", options: [] }), ctx());
    expect(res.status).toBe(400);
  });

  it("404s when the project is gone", async () => {
    projectFindById.mockResolvedValue(null);

    const res = await POST(request("POST", body), ctx());

    expect(res.status).toBe(404);
  });

  it("refuses a duplicate name", async () => {
    project(["Points"]);

    const res = await POST(request("POST", body), ctx());

    expect(res.status).toBe(409);
  });

  it("adds a field", async () => {
    const res = await POST(request("POST", body), ctx());

    expect(res.status).toBe(201);
    expect(doc.customFields.map((f) => f.name)).toEqual(["Points"]);
  });

  // BP-719: the array is read on every board load and its ceiling was a count read against the
  // document loaded above it — every concurrent racer saw the same pre-write length, so N
  // racers landed the array at MAX_FIELDS + N - 1.
  it(`refuses the ${MAX_FIELDS + 1}th field`, async () => {
    projectAtTheCeiling();

    const res = await POST(request("POST", { name: "one too many", fieldType: "text" }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Maximum ${MAX_FIELDS} custom fields per project` });
  });

  // A ceiling-filter miss also fires when the project was deleted between the earlier findById
  // and this write — the two must not both read as "full" (review).
  it("404s, not 400, when the project vanished between the read and the write", async () => {
    projectAtTheCeiling();
    projectExists.mockResolvedValue(false);

    const res = await POST(request("POST", { name: "one too many", fieldType: "text" }), ctx());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found" });
  });

  it(`still adds the ${MAX_FIELDS}th`, async () => {
    project(Array.from({ length: MAX_FIELDS - 1 }, (_, i) => `f${i}`));

    const res = await POST(request("POST", { name: "the last one", fieldType: "text" }), ctx());

    expect(res.status).toBe(201);
  });

  // The bound is in the write's own filter, not in a count read against the document loaded
  // above it. A test can only see that shape by pinning the exact call — this is the one that
  // would go red if the ceiling ever moved back to a count read (BP-719).
  it("carries the ceiling in the write filter rather than checking it beforehand", async () => {
    await POST(request("POST", body), ctx());

    expect(projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT_ID, [`customFields.${MAX_FIELDS - 1}`]: { $exists: false } },
      {
        $push: {
          customFields: {
            name: "Points",
            fieldType: "number",
            options: [],
            required: false,
            order: 0,
            showOnCard: false,
            showInList: false,
            filterable: false,
            archived: false,
          },
        },
      },
      { returnDocument: "after" }
    );
  });
});

// BP-782: a field added from Task fields left no trace in the project's audit log
describe("what adding a field records", () => {
  beforeEach(() => {
    getAuthUser.mockResolvedValue(OWNER);
    check.mockResolvedValue(true);
    project(["Existing"]);
  });

  it("names the field and its type once it is stored", async () => {
    const res = await POST(request("POST", { name: "  Story points ", fieldType: "number" }), ctx());

    expect(res.status).toBe(201);
    expect(logProjectAudit).toHaveBeenCalledWith(
      PROJECT_ID,
      "u1",
      "settings_updated",
      "Custom field added: Story points (number)"
    );
  });

  it("records nothing for an add that did not happen", async () => {
    project(Array.from({ length: MAX_FIELDS }, (_, i) => `Field ${i}`));
    projectExists.mockResolvedValue(true);

    const res = await POST(request("POST", { name: "One too many", fieldType: "number" }), ctx());

    expect(res.status).toBe(400);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });
});
