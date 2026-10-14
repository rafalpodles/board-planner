import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectStatusHistories = vi.fn();
const projectFindById = vi.fn();
const sprintFindOne = vi.fn();
const plan = vi.hoisted(() => ({ value: "pro" as "free" | "pro" }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/organisation", () => ({
  getOrganisation: async () => ({ _id: "t1", entitlements: { plan: plan.value, features: [] } }),
}));
vi.mock("@/lib/status-history", () => ({ projectStatusHistories }));
vi.mock("@/models/project", () => ({ Project: { findOne: projectFindById } }));
vi.mock("@/models/sprint", () => ({ Sprint: { findOne: sprintFindOne } }));

const { GET } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const SPRINT_ID = "507f1f77bcf86cd799439022";
const FIELD_ID = "507f1f77bcf86cd799439033";
const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });
const insights = (query = "") =>
  GET(new Request(`http://localhost/api/projects/${PROJECT_ID}/insights${query}`), {
    params: Promise.resolve({ projectId: PROJECT_ID }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  plan.value = "pro";
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  projectFindById.mockReturnValue(lean({ _id: PROJECT_ID, customFields: [], estimateFieldId: "" }));
  sprintFindOne.mockReturnValue(lean(null));
  projectStatusHistories.mockResolvedValue([]);
});

describe("GET /api/projects/[projectId]/insights — the guard", () => {
  it("answers a Pro member who reaches the project", async () => {
    const res = await insights();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ empty: true, sprint: null, window: { weeks: 12 } });
  });

  it("401 with no credential, before anything is read", async () => {
    getAuthUser.mockResolvedValue(null);

    const res = await insights();

    expect(res.status).toBe(401);
    expect(projectStatusHistories).not.toHaveBeenCalled();
  });

  it("refuses a person who cannot reach the project before any plan question", async () => {
    plan.value = "free";
    check.mockResolvedValue(false);

    const res = await insights();

    expect(res.status).toBe(403);
    expect(projectStatusHistories).not.toHaveBeenCalled();
  });

  it("402 naming the key on a Free organisation, without reading any history", async () => {
    plan.value = "free";

    const res = await insights();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ feature: "reports.insights", plan: "free" });
    expect(projectStatusHistories).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/[projectId]/insights — the query", () => {
  it("400 for weeks out of range", async () => {
    expect((await insights("?weeks=0")).status).toBe(400);
    expect((await insights("?weeks=53")).status).toBe(400);
  });

  it("400 for a sprint that is not an id, 404 for one the project does not have", async () => {
    expect((await insights("?sprint=$where")).status).toBe(400);

    const res = await insights(`?sprint=${SPRINT_ID}`);

    expect(res.status).toBe(404);
    expect(sprintFindOne.mock.calls[0][0]).toMatchObject({ _id: SPRINT_ID, project: PROJECT_ID });
  });

  it("scopes to the sprint's tasks", async () => {
    sprintFindOne.mockReturnValue(
      lean({ _id: SPRINT_ID, name: "S1", startDate: new Date(Date.now() - 10 * 86_400_000), endDate: new Date() })
    );
    const done = (taskNumber: number, sprint: string | null) => ({
      taskId: `t${taskNumber}`,
      taskNumber,
      title: "",
      category: "bug",
      sprint,
      status: "done",
      role: "done",
      archived: false,
      createdAt: new Date(Date.now() - 3 * 86_400_000),
      estimate: null,
      history: {
        kind: "recorded",
        startedAt: new Date(Date.now() - 2 * 86_400_000),
        startInferred: false,
        finishedAt: new Date(Date.now() - 86_400_000),
        reopened: 0,
        endedIn: "done",
        unknownColumns: [],
        gap: false,
      },
    });
    projectStatusHistories.mockResolvedValue([done(1, SPRINT_ID), done(2, null)]);

    const body = await (await insights(`?sprint=${SPRINT_ID}`)).json();

    expect(body.sprint).toMatchObject({ id: SPRINT_ID, name: "S1" });
    expect(body.summary.throughput).toBe(1);
    expect(body.window.weeks).toBe(2);
  });

  it("narrows to one category when asked", async () => {
    const finished = (taskNumber: number, category: string) => ({
      taskId: `t${taskNumber}`,
      taskNumber,
      title: "",
      category,
      sprint: null,
      status: "done",
      role: "done",
      archived: false,
      createdAt: new Date(Date.now() - 3 * 86_400_000),
      estimate: null,
      history: {
        kind: "recorded",
        startedAt: new Date(Date.now() - 2 * 86_400_000),
        startInferred: false,
        finishedAt: new Date(Date.now() - 86_400_000),
        reopened: 0,
        endedIn: "done",
        unknownColumns: [],
        gap: false,
      },
    });
    projectStatusHistories.mockResolvedValue([finished(1, "bug"), finished(2, "doc")]);

    const body = await (await insights("?category=bug")).json();
    const all = await (await insights()).json();

    expect(body).toMatchObject({ category: "bug", summary: { throughput: 1 } });
    expect(all).toMatchObject({ category: null, summary: { throughput: 2 } });
  });

  it("asks for the estimate only when a live number field is designated", async () => {
    projectFindById.mockReturnValue(
      lean({
        _id: PROJECT_ID,
        estimateFieldId: FIELD_ID,
        customFields: [{ _id: new Types.ObjectId(FIELD_ID), name: "Points", fieldType: "number", archived: false }],
      })
    );

    const body = await (await insights()).json();

    expect(projectStatusHistories.mock.calls[0][2]).toEqual({ estimateFieldId: FIELD_ID });
    expect(body.byEstimate).toEqual({ field: { id: FIELD_ID, name: "Points" }, values: {} });
  });

  it("shows no estimate breakdown when the designated field is archived", async () => {
    projectFindById.mockReturnValue(
      lean({
        _id: PROJECT_ID,
        estimateFieldId: FIELD_ID,
        customFields: [{ _id: new Types.ObjectId(FIELD_ID), name: "Points", fieldType: "number", archived: true }],
      })
    );

    const body = await (await insights()).json();

    expect(body).not.toHaveProperty("byEstimate");
  });
});
