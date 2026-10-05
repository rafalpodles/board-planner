import { describe, it, expect, vi, beforeEach } from "vitest";

const taskFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));
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

beforeEach(() => {
  vi.clearAllMocks();
  taskFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });
});

const suggest = (q: string) =>
  GET(new Request(`https://app.example.com/x?q=${q}`), { params: Promise.resolve({ projectId: "p1" }) });

describe("GET .../tasks/suggest and archived tasks", () => {
  it.each(["12", "flaky"])("never offers an archived task, whether the query is a number or text (%s)", async (q) => {
    await suggest(q);

    expect(taskFind.mock.calls[0][0]).toMatchObject({ project: "p1", archivedAt: null });
  });
});
