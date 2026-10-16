import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ gatewayWrite: vi.fn(), queries: [] as Record<string, unknown>[] }));
vi.mock("@/lib/ai-gateway", () => ({ gatewayWrite: m.gatewayWrite }));
vi.mock("@/lib/pm/availability", () => ({ resolveAiModel: async () => "openai/gpt-6-luna" }));

const { lexicalScore, duplicatesFrom, findDuplicates, SHORTLIST_MIN_SCORE, DUPLICATES_MAX } = await import("./duplicates");

const TASKS = [
  { _id: "a", taskNumber: 1, title: "Export invoices to CSV", description: "Accounting wants a spreadsheet of invoices", status: "todo" },
  { _id: "b", taskNumber: 2, title: "Dark mode toggle in settings", description: "", status: "todo" },
  { _id: "c", taskNumber: 3, title: "Invoices CSV download is broken", description: "", status: "doing" },
];

function fakeDb(tasks = TASKS) {
  return {
    Project: { findById: () => ({ lean: async () => ({ key: "TP" }) }) },
    Task: {
      find: (filter: Record<string, unknown>) => {
        m.queries.push(filter);
        const not = (filter._id as { $nin?: string[] } | undefined)?.$nin ?? [];
        const rows = tasks.filter((t) => !not.includes(t._id));
        return { sort: () => ({ limit: () => ({ lean: async () => rows }) }) };
      },
    },
  } as never;
}

const DRAFT = { title: "Download invoices as a CSV file", description: "For the accountants" };

beforeEach(() => {
  m.gatewayWrite.mockReset();
  m.queries.length = 0;
});

describe("the lexical shortlist", () => {
  it("scores the same work in other words above the line, and unrelated work below it", () => {
    expect(lexicalScore(DRAFT, TASKS[0])).toBeGreaterThanOrEqual(SHORTLIST_MIN_SCORE);
    expect(lexicalScore(DRAFT, TASKS[1])).toBeLessThan(SHORTLIST_MIN_SCORE);
  });

  it("does not shortlist a task for one word its description shares", () => {
    expect(lexicalScore({ title: "Login page error", description: "" }, { title: "Refactor settings", description: "Settings shows an error now" })).toBeLessThan(SHORTLIST_MIN_SCORE);
  });
});

describe("what is kept of an answer", () => {
  const candidates = [
    { taskId: "a", taskNumber: 1, key: "TP-1", title: "Export invoices to CSV", status: "todo", description: "", score: 0.5 },
    { taskId: "c", taskNumber: 3, key: "TP-3", title: "Invoices CSV download is broken", status: "doing", description: "", score: 0.4 },
  ];

  it("keeps the shortlist's keys once each, and drops a key it was never offered", () => {
    const text = JSON.stringify({ duplicates: [{ key: "tp-1", reason: "Same export" }, { key: "TP-1" }, { key: "TP-2", reason: "Told to" }, { key: "TP-3" }] });
    expect(duplicatesFrom(text, candidates)).toEqual([
      { taskId: "a", taskNumber: 1, key: "TP-1", title: "Export invoices to CSV", status: "todo", reason: "Same export" },
      { taskId: "c", taskNumber: 3, key: "TP-3", title: "Invoices CSV download is broken", status: "doing", reason: "" },
    ]);
  });

  it("answers nothing for prose, broken JSON or a missing list, and at most so many", () => {
    expect(duplicatesFrom("TP-1 looks the same", candidates)).toEqual([]);
    expect(duplicatesFrom("{nope}", candidates)).toEqual([]);
    expect(duplicatesFrom('{"other":[]}', candidates)).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => ({ taskId: `t${i}`, taskNumber: i + 10, key: `TP-${i + 10}`, title: "x", status: "todo", description: "", score: 1 }));
    expect(duplicatesFrom(JSON.stringify({ duplicates: many.map((c) => ({ key: c.key })) }), many)).toHaveLength(DUPLICATES_MAX);
  });
});

describe("findDuplicates", () => {
  it("asks no model when nothing on the board comes close", async () => {
    const result = await findDuplicates(fakeDb(), { projectId: "p1", userId: "u1" }, { title: "Quantum zebra", description: "" });
    expect(result).toEqual({ ok: true, duplicates: [], shortlisted: 0 });
    expect(m.gatewayWrite).not.toHaveBeenCalled();
  });

  it("ranks the shortlist through the gateway as duplicates, leaving out the task asked about and archived ones", async () => {
    m.gatewayWrite.mockResolvedValue({ ok: true, text: '{"duplicates":[{"key":"TP-1","reason":"Same export"}]}' });
    const result = await findDuplicates(fakeDb(), { projectId: "p1", userId: "u1" }, { ...DRAFT, description: `${DRAFT.description} ${"x".repeat(5000)}` }, ["c"]);
    expect(result).toMatchObject({ ok: true, duplicates: [{ key: "TP-1", reason: "Same export" }], shortlisted: 1 });
    expect(m.queries[0]).toMatchObject({ project: "p1", archivedAt: null, _id: { $nin: ["c"] } });
    const [, context, call] = m.gatewayWrite.mock.calls[0];
    expect(context).toEqual({ projectId: "p1", userId: "u1", source: "duplicates" });
    expect(call.data.draft.description).toHaveLength(600);
    expect(call.data).toMatchObject({ candidates: [{ key: "TP-1", title: "Export invoices to CSV", description: "Accounting wants a spreadsheet of invoices" }] });
  });

  it("passes on what the gateway refused", async () => {
    m.gatewayWrite.mockResolvedValue({ ok: false, status: 429, body: { reason: "ai_budget" } });
    expect(await findDuplicates(fakeDb(), { projectId: "p1", userId: "u1" }, DRAFT)).toEqual({ ok: false, status: 429, body: { reason: "ai_budget" } });
  });
});
