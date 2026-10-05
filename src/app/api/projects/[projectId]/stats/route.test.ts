import { describe, it, expect, vi, beforeEach } from "vitest";

const taskAggregate = vi.fn();
const taskFind = vi.fn();
const projectFindOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { aggregate: taskAggregate, find: taskFind } }));
vi.mock("@/models/project", () => ({ Project: { findOne: projectFindOne } }));
vi.mock("@/lib/middleware", async () => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    withProjectAccess:
      (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
      (req: Request, ctx: unknown) =>
        handler(req, { ...(ctx as object), user: { _id: "u1" }, db: scopedToDefaultOrganisation() }),
  };
});

const { GET } = await import("./route");

const PROJECT = "507f1f77bcf86cd799439011";

beforeEach(() => {
  vi.clearAllMocks();
  projectFindOne.mockReturnValue({ lean: async () => ({ customFields: [], columns: [] }) });
  taskAggregate.mockResolvedValue([]);
  taskFind.mockReturnValue({ lean: async () => [] });
});

const stagesOf = (call: unknown[]) => call[0] as { $match?: Record<string, unknown> }[];

describe("GET .../stats and archived tasks", () => {
  it("counts, breaks down and charts only the tasks nobody archived", async () => {
    const res = await GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ projectId: PROJECT }) });

    expect(res.status).toBe(200);
    expect(stagesOf(taskAggregate.mock.calls[0]).find((s) => s.$match?.project)?.$match).toMatchObject({ archivedAt: null });
    expect(taskFind.mock.calls[0][0]).toMatchObject({ archivedAt: null });
  });

  it("still counts every task that holds a project field value, archived or not, since deleting the field loses them all", async () => {
    await GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ projectId: PROJECT }) });

    const usage = taskAggregate.mock.calls
      .map(stagesOf)
      .find((stages) => stages.some((stage) => JSON.stringify(stage).includes("objectToArray")));
    expect(usage?.find((s) => s.$match?.project)?.$match).not.toHaveProperty("archivedAt");
  });
});
