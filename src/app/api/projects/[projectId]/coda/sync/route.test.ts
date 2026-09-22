import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * BP-472. This route had no test at any level — the word "coda" appeared only in `e2e/seed.ts`.
 * The database, task lookup and the Coda HTTP calls are stubbed; the column-check-then-upsert
 * sequencing, the task-row shaping and the response shape are the real route.
 */

const { projectFindById, taskFind, decryptSecret, fetchTableColumns, upsertTaskRows } = vi.hoisted(
  () => ({
    projectFindById: vi.fn(),
    taskFind: vi.fn(),
    decryptSecret: vi.fn((v: string) => `plain:${v}`),
    fetchTableColumns: vi.fn(),
    upsertTaskRows: vi.fn(),
  })
);

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request, ctx: unknown) =>
      handler(req, ctx),
}));
// Partial: normaliseCodaHost and missingColumns are the real, unit-tested rules; only the network
// calls are replaced.
vi.mock("@/lib/coda", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coda")>()),
  fetchTableColumns,
  upsertTaskRows,
}));

const { POST } = await import("./route");

const CODA_COLUMNS = ["Key", "Title", "Status", "Assignee", "Priority", "Difficulty", "Category", "Due", "Link"];

function project(over: Record<string, unknown> = {}) {
  return {
    _id: "p1",
    key: "BP",
    codaDocId: "doc1",
    codaTableId: "table1",
    codaHost: "https://coda.io",
    codaToken: "enc-token",
    customFields: [],
    ...over,
  };
}

const request = () =>
  new Request("https://app.example.com/api/projects/p1/coda/sync", { method: "POST" });
const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  decryptSecret.mockImplementation((v: string) => `plain:${v}`);
  projectFindById.mockReturnValue({ lean: () => Promise.resolve(project()) });
  taskFind.mockReturnValue({
    sort: () => ({
      populate: () => ({ lean: () => Promise.resolve([]) }),
    }),
  });
  fetchTableColumns.mockResolvedValue(CODA_COLUMNS);
  upsertTaskRows.mockResolvedValue({ pushed: 0, requests: 0, allApplied: true });
});

describe("POST .../coda/sync — configuration", () => {
  it("refuses when the project has no doc, table or token configured", async () => {
    projectFindById.mockReturnValue({ lean: () => Promise.resolve(project({ codaDocId: "" })) });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(400);
    expect(fetchTableColumns).not.toHaveBeenCalled();
  });

  it("decrypts the stored token before calling Coda, never the ciphertext", async () => {
    await POST(request(), ctx());

    expect(decryptSecret).toHaveBeenCalledWith("enc-token");
    expect(fetchTableColumns).toHaveBeenCalledWith("https://coda.io", "doc1", "table1", "plain:enc-token");
  });
});

describe("POST .../coda/sync — the column check", () => {
  it("reports which columns are missing, and does not attempt the upsert", async () => {
    fetchTableColumns.mockResolvedValue(["Key", "Title"]);

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Status");
    expect(body.error).toContain("Assignee");
    expect(upsertTaskRows).not.toHaveBeenCalled();
  });

  it("proceeds to sync once every column is present, in any case or order", async () => {
    fetchTableColumns.mockResolvedValue([...CODA_COLUMNS].reverse());

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(upsertTaskRows).toHaveBeenCalledTimes(1);
  });

  it("turns a failed column fetch into a 502, not a 500 or a false pass", async () => {
    fetchTableColumns.mockRejectedValue(new Error("Coda is down"));

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Coda is down");
    expect(upsertTaskRows).not.toHaveBeenCalled();
  });
});

describe("POST .../coda/sync — the pushed rows", () => {
  it("shapes each task into the row Coda expects, keyed by the project's own key", async () => {
    taskFind.mockReturnValue({
      sort: () => ({
        populate: () => ({
          lean: () =>
            Promise.resolve([
              {
                taskNumber: 5,
                title: "Ship it",
                status: "in_review",
                assignee: { fullName: "Ada Lovelace", username: "ada" },
                priority: "high",
                category: "bug",
                dueDate: new Date("2026-09-01T00:00:00Z"),
                customFieldValues: {},
              },
            ]),
        }),
      }),
    });

    await POST(request(), ctx());

    const [, , , , rows] = upsertTaskRows.mock.calls[0];
    expect(rows).toEqual([
      expect.objectContaining({
        key: "BP-5",
        title: "Ship it",
        assignee: "Ada Lovelace",
        priority: "high",
        category: "bug",
        due: "2026-09-01",
      }),
    ]);
  });

  describe("the link each row carries", () => {
    const oneTask = () =>
      taskFind.mockReturnValue({
        sort: () => ({
          populate: () => ({
            lean: () => Promise.resolve([{ taskNumber: 5, title: "Ship it", status: "todo", customFieldValues: {} }]),
          }),
        }),
      });
    const pushedLink = () => upsertTaskRows.mock.calls[0][4][0].link;

    afterEach(() => {
      delete process.env.PUBLIC_ORIGIN;
      delete process.env.APP_ORIGIN;
      delete process.env.NEXT_PUBLIC_APP_URL;
    });

    // BP-766: a published image is built once for every self-hoster, so the address comes from
    // the runtime environment and a build-time NEXT_PUBLIC_APP_URL is not consulted
    it("points at PUBLIC_ORIGIN, read when the sync runs", async () => {
      oneTask();
      process.env.PUBLIC_ORIGIN = "https://board.example.org";
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

      await POST(request(), ctx());

      expect(pushedLink()).toBe("https://board.example.org/projects/BP/tasks/5");
    });

    it("is left empty when this instance's origin is not configured", async () => {
      oneTask();
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

      await POST(request(), ctx());

      expect(pushedLink()).toBe("");
    });
  });

  it("reports partial application rather than claiming success", async () => {
    upsertTaskRows.mockResolvedValue({ pushed: 3, requests: 1, allApplied: false });

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(body.synced).toBe(true);
    expect(body.allApplied).toBe(false);
    expect(body.tasksPushed).toBe(3);
  });

  it("turns a failed upsert into a 502", async () => {
    upsertTaskRows.mockRejectedValue(new Error("write refused"));

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("write refused");
  });
});
