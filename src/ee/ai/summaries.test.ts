import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const m = vi.hoisted(() => ({ gatewayWrite: vi.fn(), digest: vi.fn(), histories: vi.fn() }));
vi.mock("@/lib/ai-gateway", () => ({ gatewayWrite: m.gatewayWrite }));
vi.mock("@/lib/pm/availability", () => ({ resolveAiModel: async () => "openai/gpt-6-luna" }));
vi.mock("@/lib/pm/board-review", () => ({ buildBoardDigest: m.digest, MAX_TASKS_SCANNED: 500 }));
vi.mock("@/lib/status-history", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/status-history")>()), projectStatusHistories: m.histories }));

const { figuresOutsideFacts, renderFacts, summaryFacts, summaryInstructions, writeSummary } = await import("./summaries");

const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 86_400_000;
const COLUMNS = [
  { id: "todo", label: "To Do", role: "approved", order: 0 },
  { id: "doing", label: "Doing", role: "active", order: 1 },
  { id: "stuck", label: "Blocked", role: "blocked", order: 2 },
  { id: "done", label: "Done", role: "done", order: 3 },
];

const FACTS = {
  kind: "sprint" as const,
  title: "Sprint status: S7",
  figures: [
    { label: "Tasks in the sprint", value: 8 },
    { label: "Done", value: 5 },
  ],
  lists: [{ label: "At risk", items: [{ key: "TP-12", title: "Wire it", note: "4 days in Doing" }] }],
};

beforeEach(() => Object.values(m).forEach((fn) => fn.mockReset()));

describe("the figures a summary may give", () => {
  it("are the server's, in Markdown, with the lists under them", () => {
    expect(renderFacts(FACTS)).toBe(
      ["## Sprint status: S7", "", "- Tasks in the sprint: **8**", "- Done: **5**", "", "**At risk**", "- TP-12 Wire it (4 days in Doing)"].join("\n")
    );
  });

  it("finds every number in a note that the server did not count, the board's own task keys aside", () => {
    expect(figuresOutsideFacts("8 in, 5 done; TP-12 lags.", FACTS)).toEqual([]);
    expect(figuresOutsideFacts("Only 62.5% is done after 3 days, and 2,000 lines.", FACTS)).toEqual(["62.5", "3", "2,000"]);
    // A key the board did not give is not a key to it
    expect(figuresOutsideFacts("BP-999 is late.", FACTS)).toEqual(["999"]);
  });

  it("strips a board's own key whole, whatever its key is made of", () => {
    const facts = { ...FACTS, lists: [{ label: "At risk", items: [{ key: "WEB_APP-12", title: "a", note: "" }, { key: "WEB-APP-7", title: "b", note: "" }] }] };
    expect(figuresOutsideFacts("WEB_APP-12 and WEB-APP-7 lag.", facts)).toEqual([]);
    expect(figuresOutsideFacts("APP-7 and WEB_APP-120 lag.", facts)).toEqual(["7", "120"]);
  });

  it("counts a number written as a word as one of the note's own, since it cannot be checked", () => {
    expect(figuresOutsideFacts("Three tasks are blocked and half the sprint is left.", FACTS)).toEqual(["Three", "half"]);
    expect(figuresOutsideFacts("TP-12 needs a decision; double-check it this quarter.", FACTS)).toEqual([]);
  });

  it("tells the model to write no figures, so the server's are the only ones", () => {
    expect(summaryInstructions("standup")).toMatch(/last day[^]*Write no figures at all/);
  });
});

describe("writeSummary", () => {
  it("puts the note above the server's figures, through the gateway as a digest", async () => {
    m.gatewayWrite.mockResolvedValue({ ok: true, text: "TP-12 is the one to watch." });
    const result = await writeSummary({ organisation: "org" } as never, { projectId: "p1", userId: "u1" }, FACTS);
    expect(result).toEqual({ ok: true, markdown: `TP-12 is the one to watch.\n\n${renderFacts(FACTS)}`, note: "TP-12 is the one to watch.", noteDropped: false });
    expect(m.gatewayWrite).toHaveBeenCalledWith(expect.anything(), { projectId: "p1", userId: "u1", source: "digest" }, { model: "openai/gpt-6-luna", instructions: summaryInstructions("sprint"), data: FACTS });
  });

  it("drops a note that counts for itself, and keeps the figures", async () => {
    m.gatewayWrite.mockResolvedValue({ ok: true, text: "Nearly 70% done with 2 days to go." });
    expect(await writeSummary({} as never, { projectId: "p1", userId: "u1" }, FACTS)).toEqual({ ok: true, markdown: renderFacts(FACTS), note: null, noteDropped: true });
  });

  it("passes on what the gateway refused", async () => {
    m.gatewayWrite.mockResolvedValue({ ok: false, status: 429, body: { reason: "ai_budget" } });
    expect(await writeSummary({} as never, { projectId: "p1", userId: "u1" }, FACTS)).toEqual({ ok: false, status: 429, body: { reason: "ai_budget" } });
  });
});

const queries: Record<string, unknown>[] = [];

function fakeDb(data: { tasks?: Record<string, unknown>[]; logs?: Record<string, unknown>[]; users?: Record<string, unknown>[]; sprint?: Record<string, unknown> | null }) {
  const lean = <T>(v: T) => ({ lean: async () => v, sort: () => ({ lean: async () => v }) });
  return {
    Project: { findById: () => lean({ key: "TP", columns: COLUMNS }) },
    Sprint: { findOne: () => lean(data.sprint ?? null) },
    ActivityLog: { find: () => lean(data.logs ?? []) },
    User: { find: () => lean(data.users ?? []) },
    Task: {
      countDocuments: async (filter: Record<string, unknown>) => (data.tasks ?? []).filter((t) => t.status === filter.status).length,
      find: (filter: Record<string, unknown>) => {
        const all = data.tasks ?? [];
        queries.push(filter);
        const notIn = (filter.status as { $nin?: string[] } | undefined)?.$nin ?? [];
        if (filter.$or) return lean(all.filter((t) => !notIn.includes(t.status as string) && (t.status === "stuck" || (t.blockedBy as unknown[] | undefined)?.length)));
        if (filter._id) return lean(all.filter((t) => !notIn.includes(t.status as string) && ((filter._id as { $in: unknown[] }).$in as unknown[]).some((id) => String(id) === String(t._id))));
        return lean(all);
      },
    },
  } as never;
}

describe("summaryFacts", () => {
  it("counts a standup's moves by person, and what is blocked by a column or by a blocker not yet done", async () => {
    queries.length = 0;
    const [a, b, c, d, e] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const ann = new Types.ObjectId();
    const db = fakeDb({
      tasks: [
        { _id: a, taskNumber: 1, title: "Export", status: "done" },
        { _id: b, taskNumber: 2, title: "Login", status: "stuck", blockedBy: [] },
        { _id: c, taskNumber: 3, title: "Waits on an open task", status: "todo", blockedBy: [d] },
        { _id: d, taskNumber: 4, title: "Open blocker", status: "doing" },
        { _id: e, taskNumber: 5, title: "Waits on a finished task", status: "todo", blockedBy: [a] },
      ],
      logs: [
        { task: a, user: ann, oldValue: "doing", newValue: "done" },
        { task: b, user: ann, oldValue: "doing", newValue: "stuck" },
        { task: a, user: null, oldValue: "todo", newValue: "doing" },
      ],
      users: [{ _id: ann, username: "ann", fullName: "Ann Lee" }],
    });
    const facts = (await summaryFacts(db, "p1", "standup", null, NOW))!;
    expect(facts.figures).toEqual([
      { label: "Moves between columns in the last day", value: 3 },
      { label: "People who moved work", value: 1 },
      { label: "Blocked tasks", value: 2 },
    ]);
    expect(facts.lists.at(-1)!.items.map((i) => i.key)).toEqual(["TP-2", "TP-3"]);
    // A move with nobody behind it is the board's, not a person's
    expect(facts.lists.map((l) => l.label)).toContain("Moved by The board");
    expect(queries.every((q) => q.project === "p1" && q.archivedAt === null)).toBe(true);
    expect(facts.lists[0]).toEqual({
      label: "Moved by Ann Lee",
      items: [
        { key: "TP-1", title: "Export", note: "Doing → Done" },
        { key: "TP-2", title: "Login", note: "Doing → Blocked" },
      ],
    });
  });

  it("measures a sprint against its own tasks, and flags what has sat in one column", async () => {
    const ids = [1, 2, 3, 4].map(() => new Types.ObjectId());
    const db = fakeDb({
      sprint: { name: "S7", endDate: new Date(NOW.getTime() + 3.5 * DAY) },
      tasks: [
        { _id: ids[0], taskNumber: 1, title: "Done one", status: "done", createdAt: new Date(NOW.getTime() - 9 * DAY) },
        { _id: ids[1], taskNumber: 2, title: "Fresh", status: "doing", createdAt: new Date(NOW.getTime() - 1 * DAY) },
        { _id: ids[2], taskNumber: 3, title: "Old", status: "doing", createdAt: new Date(NOW.getTime() - 9 * DAY) },
        { _id: ids[3], taskNumber: 4, title: "Moved lately", status: "todo", createdAt: new Date(NOW.getTime() - 9 * DAY) },
      ],
      logs: [{ task: ids[3], createdAt: new Date(NOW.getTime() - 1 * DAY) }],
    });
    const facts = (await summaryFacts(db, "p1", "sprint", "s7", NOW))!;
    expect(facts.figures.map((f) => f.value)).toEqual([4, 1, 3, 4, 1]);
    expect(facts.lists[0].items).toEqual([{ key: "TP-3", title: "Old", note: "9 days in Doing" }]);
    expect(await summaryFacts(fakeDb({ sprint: null }), "p1", "sprint", "nope", NOW)).toBeNull();
  });

  it("counts the project's week from the board's own digest and history", async () => {
    m.digest.mockResolvedValue({ projectKey: "TP", openTotal: 6, byStatus: [{ status: "todo", label: "To Do", count: 1 }], stale: [{ key: "TP-9", title: "Old", status: "To Do", days: 20 }], staleTotal: 14, gaps: [], duplicates: [], truncated: true });
    m.histories.mockResolvedValue([
      { taskNumber: 1, title: "Shipped", role: "done", archived: false, createdAt: new Date(NOW.getTime() - 3 * DAY), history: { kind: "recorded", finishedAt: new Date(NOW.getTime() - DAY) } },
      { taskNumber: 2, title: "Shipped long ago", role: "done", archived: false, createdAt: new Date(NOW.getTime() - 30 * DAY), history: { kind: "recorded", finishedAt: new Date(NOW.getTime() - 20 * DAY) } },
      { taskNumber: 3, title: "Archived", role: "done", archived: true, createdAt: new Date(NOW.getTime() - DAY), history: { kind: "recorded", finishedAt: new Date(NOW.getTime() - DAY) } },
    ]);
    const facts = (await summaryFacts(fakeDb({ tasks: Array.from({ length: 6 }, (_, i) => ({ status: i < 4 ? "todo" : "doing" })) }), "p1", "project", null, NOW))!;
    expect(facts.figures).toEqual([
      { label: "Tasks created", value: 1 },
      { label: "Tasks finished", value: 1 },
      { label: "Open tasks", value: 6 },
      // Counted per column, not from the digest's capped scan; the stuck count says the scan it came from
      { label: "Open in To Do", value: 4 },
      { label: "Open in Doing", value: 2 },
      { label: "Stuck in a column, of the 500 newest open tasks", value: 14 },
    ]);
  });
});
