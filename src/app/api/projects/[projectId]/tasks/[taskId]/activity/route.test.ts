import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";

const exists = vi.fn();
const find = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { exists } }));
vi.mock("@/models/activityLog", () => ({ ActivityLog: { find } }));
const agentFind = vi.fn();
vi.mock("@/models/agent", () => ({ Agent: { find: agentFind } }));
vi.mock("@/lib/middleware", async () => {
  const { scopedToDefaultTenant } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    withProjectAccess:
      (handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request, ctx: unknown) =>
        handler(req, { ...(ctx as object), db: scopedToDefaultTenant() }),
  };
});

const { GET } = await import("./route");

const minute = 60_000;
const t0 = Date.parse("2026-09-21T10:00:00Z");

interface Row {
  _id: string;
  user: string;
  action: string;
  field: string;
  customField?: boolean;
  fieldType?: string;
  oldValue: string;
  newValue: string;
  createdAt: Date;
}

const row = (id: string, minutesAgo: number, over: Partial<Row> = {}): Row => ({
  _id: id,
  user: "u1",
  action: "updated",
  field: "description",
  oldValue: "",
  newValue: "",
  createdAt: new Date(t0 - minutesAgo * minute),
  ...over,
});

let headerQuery: { sort: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> };

function serve(rows: Row[], { scanned = rows }: { scanned?: Row[] } = {}) {
  headerQuery = {
    sort: vi.fn(() => headerQuery),
    limit: vi.fn(() => headerQuery),
    select: vi.fn(() => ({ lean: () => Promise.resolve(scanned) })),
  };
  find.mockImplementation((filter: { _id?: { $in: string[] } }) => {
    if (!filter._id) return headerQuery;
    const wanted = new Set(filter._id.$in);
    // The second query comes back in no particular order, which the route must not rely on
    const picked = rows.filter((r) => wanted.has(r._id)).reverse();
    return { populate: () => ({ lean: () => Promise.resolve(picked) }) };
  });
}

async function read(): Promise<Row[]> {
  const res = await GET(new Request("http://x/api/projects/p1/tasks/t1/activity"), {
    params: Promise.resolve({ projectId: "p1", taskId: "t1" }),
  } as never);
  return res.json();
}

beforeEach(() => {
  exists.mockReset().mockResolvedValue(true);
  find.mockReset();
  agentFind.mockReset().mockReturnValue({ lean: () => Promise.resolve([]) });
});

describe("GET task activity", () => {
  it("reads this task's history newest first, with the columns a session is judged on", async () => {
    serve([row("a", 1)]);
    await read();

    expect(find).toHaveBeenCalledWith({ task: "t1", tenant: DEFAULT_TENANT_ID });
    expect(headerQuery.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    const columns = String(headerQuery.select.mock.calls[0][0]).split(" ");
    expect(columns).toEqual(expect.arrayContaining(["user", "action", "field", "customField", "fieldType", "createdAt"]));
  });

  it("shows one person's run of description saves as one entry, in newest-first order", async () => {
    const rows = [
      row("s3", 1, { oldValue: "two", newValue: "three" }),
      row("s2", 3, { oldValue: "one", newValue: "two" }),
      row("s1", 5, { oldValue: "", newValue: "one" }),
      row("st", 30, { action: "status_changed", field: "status", oldValue: "todo", newValue: "doing" }),
    ];
    serve(rows);

    const shown = await read();

    expect(shown.map((r) => r._id)).toEqual(["s3", "st"]);
    expect(shown[0]).toMatchObject({ oldValue: "", newValue: "" });
    expect(shown[1]).toMatchObject({ oldValue: "todo", newValue: "doing" });
  });

  it("keeps a project field called description apart from the task's description", async () => {
    const rows = [
      row("c", 1, { customField: true, fieldType: "text", oldValue: "x", newValue: "y" }),
      row("d", 2, { oldValue: "a", newValue: "b" }),
    ];
    serve(rows);

    const shown = await read();

    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatchObject({ _id: "c", oldValue: "x", newValue: "y" });
  });

  it("drops the oldest session when the scan may have cut it off", async () => {
    const edits = Array.from({ length: 999 }, (_, i) =>
      row(`e${i}`, 30 + i, { field: "title", oldValue: `v${i + 1}`, newValue: `v${i}` })
    );
    const all = [row("st", 0, { action: "status_changed", field: "status", oldValue: "todo", newValue: "doing" }), ...edits];
    serve(all, { scanned: all });

    const shown = await read();

    expect(shown.map((r) => r._id)).toEqual(["st"]);
  });

  it("keeps the oldest session when the scan reached the start of the history", async () => {
    const all = [
      row("st", 0, { action: "status_changed", field: "status", oldValue: "todo", newValue: "doing" }),
      row("e0", 30, { field: "title", oldValue: "a", newValue: "b" }),
    ];
    serve(all);

    expect((await read()).map((r) => r._id)).toEqual(["st", "e0"]);
  });

  describe("an agent change written before BP-730, which holds ids", () => {
    const KEPT = "6ab0f94eadb2609f98d84da1";
    const GONE = "6ab0f94eadb2609f98d84da9";

    it("names an agent that still exists, and calls one that does not a deleted agent", async () => {
      agentFind.mockReturnValue({ lean: () => Promise.resolve([{ _id: KEPT, name: "Merges its own work" }]) });
      serve([row("a", 1, { field: "agent", oldValue: GONE, newValue: KEPT })]);

      const shown = await read();

      expect(agentFind).toHaveBeenCalledWith({ _id: { $in: [GONE, KEPT] }, tenant: DEFAULT_TENANT_ID }, "name");
      expect(shown[0]).toMatchObject({ oldValue: "a deleted agent", newValue: "Merges its own work" });
    });

    it("leaves a row that already holds names alone, and asks for nothing", async () => {
      serve([row("a", 1, { field: "agent", oldValue: "Default", newValue: "" })]);

      const shown = await read();

      expect(agentFind).not.toHaveBeenCalled();
      expect(shown[0]).toMatchObject({ oldValue: "Default", newValue: "" });
    });

    it("leaves a project field called agent alone", async () => {
      serve([row("a", 1, { field: "agent", customField: true, fieldType: "text", oldValue: GONE, newValue: "x" })]);

      expect((await read())[0]).toMatchObject({ oldValue: GONE });
    });
  });

  it("refuses a task from another project", async () => {
    exists.mockResolvedValue(null);
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ projectId: "p1", taskId: "t9" }) } as never);
    expect(res.status).toBe(404);
  });
});
