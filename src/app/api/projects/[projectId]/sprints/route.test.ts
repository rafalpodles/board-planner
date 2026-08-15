import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const sprintFind = vi.fn();
const projectFindById = vi.fn();
const taskAggregate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/sprint", () => ({ Sprint: { find: sprintFind } }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/task", () => ({ Task: { aggregate: taskAggregate } }));

const { GET } = await import("./route");

const USER = { _id: "u1", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";
const SPRINT_ID = "607f1f77bcf86cd799439099";
const ESTIMATE_FIELD_ID = "6a70afff45d39cd9bc8bb501";

const DONE_COLUMN = { id: "done", label: "Done", color: "#000", role: "done" as const, order: 1 };
const TODO_COLUMN = { id: "todo", label: "To Do", color: "#000", role: "approved" as const, order: 0 };

function req() {
  return new Request("http://localhost/api/projects/p1/sprints");
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

async function json(res: Response) {
  return res.json();
}

// The unit suite mocks Mongoose, so it can only prove what the *code* does with whatever
// Task.aggregate returns — never what MongoDB itself does with a string in $convert. That
// question belongs to e2e/sprint-estimates.spec.ts, against a real database.
function mockNoDesignation() {
  projectFindById.mockReturnValue({
    lean: () => Promise.resolve({ columns: [TODO_COLUMN, DONE_COLUMN], estimateFieldId: "" }),
  });
}

function mockDesignation() {
  projectFindById.mockReturnValue({
    lean: () =>
      Promise.resolve({
        columns: [TODO_COLUMN, DONE_COLUMN],
        estimateFieldId: ESTIMATE_FIELD_ID,
      }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(USER);
  check.mockResolvedValue(true);
  sprintFind.mockReturnValue({
    sort: () => ({ lean: () => Promise.resolve([{ _id: SPRINT_ID, name: "Sprint 1" }]) }),
  });
  mockNoDesignation();
  taskAggregate.mockResolvedValue([]);
});

function groupStageOf(pipeline: unknown[]): Record<string, unknown> {
  const stage = pipeline.find(
    (s): s is { $group: Record<string, unknown> } =>
      typeof s === "object" && s !== null && "$group" in s
  );
  if (!stage) throw new Error("pipeline has no $group stage");
  return stage.$group;
}

describe("GET /api/projects/[projectId]/sprints — estimate accumulators", () => {
  it("omits the estimate accumulators from the pipeline when the project designates no field", async () => {
    await GET(req(), ctx());

    const group = groupStageOf(taskAggregate.mock.calls[0][0]);
    expect(group.estimateTotal).toBeUndefined();
    expect(group.estimateDone).toBeUndefined();
  });

  it("adds the estimate accumulators to the pipeline, keyed off the designated field, when the project designates one", async () => {
    mockDesignation();

    await GET(req(), ctx());

    const group = groupStageOf(taskAggregate.mock.calls[0][0]);
    expect(group.estimateTotal).toBeDefined();
    expect(group.estimateDone).toBeDefined();
    // The dotted path is established practice (stats/route.ts) — asserted here as a string
    // rather than the exact $convert shape, so this stays a shape check and not a rewrite of
    // MongoDB's own $convert semantics.
    expect(JSON.stringify(group.estimateTotal)).toContain(
      `$customFieldValues.${ESTIMATE_FIELD_ID}`
    );
    expect(JSON.stringify(group.estimateDone)).toContain(
      `$customFieldValues.${ESTIMATE_FIELD_ID}`
    );
  });

  it("requests columns and estimateFieldId together, in one read", async () => {
    mockDesignation();

    await GET(req(), ctx());

    expect(projectFindById).toHaveBeenCalledWith(PROJECT_ID, "columns estimateFieldId");
  });

  it("carries estimateTotal/estimateDone from the aggregate result through to the response", async () => {
    mockDesignation();
    taskAggregate.mockResolvedValue([
      { _id: SPRINT_ID, total: 5, done: 2, estimateTotal: 8, estimateDone: 3 },
    ]);

    const body = await json(await GET(req(), ctx()));

    expect(body[0].estimateTotal).toBe(8);
    expect(body[0].estimateDone).toBe(3);
  });

  it("reports zero, not undefined, for a sprint the aggregate produced no group for", async () => {
    mockDesignation();
    taskAggregate.mockResolvedValue([]); // no tasks in any sprint, so no $group row at all

    const body = await json(await GET(req(), ctx()));

    expect(body[0].estimateTotal).toBe(0);
    expect(body[0].estimateDone).toBe(0);
  });

  it("omits the estimate fields entirely from the response when the project designates none", async () => {
    taskAggregate.mockResolvedValue([{ _id: SPRINT_ID, total: 5, done: 2 }]);

    const body = await json(await GET(req(), ctx()));

    expect(body[0]).not.toHaveProperty("estimateTotal");
    expect(body[0]).not.toHaveProperty("estimateDone");
  });

  // The schema doesn't constrain estimateFieldId to ObjectId hex, so a migration, a bulk
  // import, or a direct database edit could leave something else there. Trusting it straight
  // into the $convert path would let a leading "$" parse as an aggregation operator and throw
  // at parse time — the one failure onError/onNull cannot cover, since they guard conversion,
  // not a malformed path.
  it("treats a non-hex estimateFieldId (e.g. one starting with '$') as no designation", async () => {
    projectFindById.mockReturnValue({
      lean: () =>
        Promise.resolve({ columns: [TODO_COLUMN, DONE_COLUMN], estimateFieldId: "$where" }),
    });

    await GET(req(), ctx());

    const group = groupStageOf(taskAggregate.mock.calls[0][0]);
    expect(group.estimateTotal).toBeUndefined();
    expect(group.estimateDone).toBeUndefined();
  });

  it("treats an estimateFieldId of the wrong length as no designation, even if every character is hex", async () => {
    projectFindById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          columns: [TODO_COLUMN, DONE_COLUMN],
          estimateFieldId: ESTIMATE_FIELD_ID.slice(0, 12), // 12 hex chars, not 24
        }),
    });

    await GET(req(), ctx());

    const group = groupStageOf(taskAggregate.mock.calls[0][0]);
    expect(group.estimateTotal).toBeUndefined();
    expect(group.estimateDone).toBeUndefined();
  });

  it("also omits the malformed-designation case from the response, matching no-designation", async () => {
    projectFindById.mockReturnValue({
      lean: () =>
        Promise.resolve({ columns: [TODO_COLUMN, DONE_COLUMN], estimateFieldId: "$where" }),
    });
    taskAggregate.mockResolvedValue([{ _id: SPRINT_ID, total: 5, done: 2 }]);

    const body = await json(await GET(req(), ctx()));

    expect(body[0]).not.toHaveProperty("estimateTotal");
    expect(body[0]).not.toHaveProperty("estimateDone");
  });
});
