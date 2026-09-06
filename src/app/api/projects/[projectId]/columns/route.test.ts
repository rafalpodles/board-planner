import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_PROJECT_COLUMNS } from "@/types";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const taskFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit: vi.fn() }));

const { PUT } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

type Column = { id: string; label: string; color: string; role: string; order: number };

function board(columns: Column[], tasksByColumn: Record<string, number[]> = {}) {
  const doc = { key: "TP", columns, save: vi.fn(async () => {}) };
  projectFindById.mockResolvedValue(doc);
  taskFind.mockImplementation((filter: { status: string }) => ({
    select: () => ({
      sort: () => ({
        limit: async () => (tasksByColumn[filter.status] ?? []).map((taskNumber) => ({ taskNumber })),
      }),
    }),
  }));
  return doc;
}

async function put(columns: unknown[]) {
  const response = await PUT(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/columns`, {
      method: "PUT",
      body: JSON.stringify({ columns }),
    }),
    ctx()
  );
  return { status: response.status, body: await response.json() };
}

const col = (id: string, label: string, role = "backlog", order = 0): Column => ({
  id,
  label,
  color: "#6b7280",
  role,
  order,
});

const idsAndLabels = (body: unknown) =>
  (body as Column[]).map((c) => `${c.id}:${c.label}`);

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "admin" });
  check.mockResolvedValue(true);
});

describe("PUT columns · which column ends up with which id", () => {
  const stored = [
    col("todo", "To Do", "approved", 0),
    col("in_progress", "In Progress", "active", 1),
    col("done", "Done", "done", 2),
  ];
  const keep = stored.map((c) => ({ ...c }));

  it("gives a newcomer the suffix, not the id a staying column asked for", async () => {
    board(stored);
    const res = await put([
      { label: "Todo", role: "backlog" },
      ...keep,
    ]);

    expect(res.status).toBe(200);
    expect(idsAndLabels(res.body)).toEqual([
      "todo_2:Todo",
      "todo:To Do",
      "in_progress:In Progress",
      "done:Done",
    ]);
  });

  it("walks the whole chain when the suffix is taken too", async () => {
    board([...stored, col("todo_2", "Todo (2)", "backlog", 3)]);
    const res = await put([
      { label: "Todo", role: "backlog" },
      ...keep,
      col("todo_2", "Todo (2)", "backlog", 3),
    ]);

    expect(res.status).toBe(200);
    expect(idsAndLabels(res.body)[0]).toBe("todo_3:Todo");
    expect(idsAndLabels(res.body)).toContain("todo_2:Todo (2)");
  });

  it("refuses two rows naming one column rather than inventing one for the loser", async () => {
    board([...stored, col("todo_2", "Todo (2)", "backlog", 3)]);
    const res = await put([
      { ...keep[0] },
      { ...keep[0], label: "Stolen" },
      col("todo_2", "Todo (2)", "backlog", 3),
      keep[1],
      keep[2],
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot claim the same id/);
  });

  it("keeps every id unique when several newcomers slug alike", async () => {
    board([...stored, col("todo_2", "Todo (2)", "backlog", 3)]);
    const res = await put([
      { label: "Todo", role: "backlog" },
      { label: "To-Do", role: "backlog" },
      { label: "TODO", role: "backlog" },
      ...keep,
      col("todo_2", "Todo (2)", "backlog", 3),
    ]);

    expect(res.status).toBe(200);
    const ids = (res.body as Column[]).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(idsAndLabels(res.body)).toContain("todo:To Do");
    expect(idsAndLabels(res.body)).toContain("todo_2:Todo (2)");
  });

  it("ignores an id that names no column, and slugifies that entry instead", async () => {
    board(stored);
    const res = await put([{ id: "not-a-column", label: "Fresh", role: "backlog" }, ...keep]);

    expect(res.status).toBe(200);
    expect(idsAndLabels(res.body)[0]).toBe("fresh:Fresh");
  });

  it("ignores a non-string id rather than claiming with it", async () => {
    board(stored);
    for (const id of [7, null, { toString: () => "todo" }, ["todo"]]) {
      const res = await put([{ id, label: "Todo", role: "backlog" }, ...keep]);
      expect(res.status, JSON.stringify(id)).toBe(200);
      expect(idsAndLabels(res.body)[0], JSON.stringify(id)).toBe("todo_2:Todo");
    }
  });
});

describe("PUT columns · which removals are checked for tasks", () => {
  const stored = [
    col("todo", "To Do", "approved", 0),
    col("in_progress", "In Progress", "active", 1),
    col("done", "Done", "done", 2),
  ];

  it("refuses a removal whose id a newcomer reclaims, naming the tasks", async () => {
    board(stored, { todo: [4] });
    const res = await put([
      { label: "Todo", role: "backlog" },
      col("in_progress", "In Progress", "active", 1),
      col("done", "Done", "done", 2),
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Column "To Do" still has tasks: TP-4/);
  });

  it("allows it once the column is empty, and the id is free to reuse", async () => {
    board(stored, {});
    const res = await put([
      { label: "Todo", role: "backlog" },
      col("in_progress", "In Progress", "active", 1),
      col("done", "Done", "done", 2),
    ]);

    expect(res.status).toBe(200);
    expect(idsAndLabels(res.body)[0]).toBe("todo:Todo");
  });

  it("leaves an ordinary rename alone — claimed, so never a removal", async () => {
    board(stored, { todo: [4] });
    const res = await put([
      { ...col("todo", "Backlog", "approved", 0) },
      col("in_progress", "In Progress", "active", 1),
      col("done", "Done", "done", 2),
    ]);

    expect(res.status).toBe(200);
    expect(idsAndLabels(res.body)[0]).toBe("todo:Backlog");
  });
});

describe("PUT columns · the seeded seven", () => {
  it("round-trip through the editor changes nothing", async () => {
    const seven = DEFAULT_PROJECT_COLUMNS.map((c, order) => col(c.id, c.label, c.role, order));
    board(seven, { todo: [4], in_progress: [1, 3] });
    const res = await put(seven.map((c) => ({ ...c })));

    expect(res.status).toBe(200);
    expect((res.body as Column[]).map((c) => c.id)).toEqual(seven.map((c) => c.id));
  });
});
