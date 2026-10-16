import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const m = vi.hoisted(() => ({
  gatewayWrite: vi.fn(),
  updateTask: vi.fn(),
  can: vi.fn(() => true),
  provenance: [] as string[],
}));

vi.mock("@/lib/ai-gateway", () => ({ gatewayWrite: m.gatewayWrite }));
vi.mock("@/lib/pm/availability", () => ({ resolveAiModel: async () => "openai/gpt-6-luna" }));
vi.mock("@/lib/pm/pm-user", () => ({ getPmUser: async () => ({ _id: "pm" }) }));
vi.mock("@/lib/grants", () => ({ projectAudienceFilter: async () => ({}) }));
vi.mock("@/lib/organisation", () => ({ getOrganisation: async () => ({}) }));
vi.mock("@/lib/entitlements", () => ({ can: m.can }));
vi.mock("@/lib/organisation-jobs", () => ({ stillServed: async () => true }));
vi.mock("@/lib/task-service", () => ({
  updateTask: async (...args: unknown[]) => {
    const { currentProvenance } = await import("@/lib/activity-source");
    m.provenance.push(currentProvenance().source);
    return m.updateTask(...args);
  },
}));

const { suggestionsFrom, runTriage, applyOne, drainTriage, triageMaterial, TRIAGE_MAX_ATTEMPTS } = await import("./triage");
const { writtenBy, pmAgentMark } = await import("@/lib/ai-generated");

const FIELD = "f1";
const MATERIAL = {
  task: { title: "Login fails", description: "" },
  ask: { assignee: true, category: true, fieldIds: [FIELD] },
  people: [{ username: "ann", name: "Ann", recentWork: ["Auth"] }],
  categories: ["bug", "user-story"],
  fields: [{ id: FIELD, name: "Size", options: [{ id: "s", label: "S" }, { id: "m", label: "M" }] }],
};

describe("what triage keeps of an answer", () => {
  it("keeps what names a member, an offered category and an offered option", () => {
    const text = '```json\n{"assignee":{"username":"Ann","reason":"Did auth"},"category":{"name":"bug","reason":"It fails"},"fields":[{"id":"f1","option":"M","reason":"Medium"}]}\n```';
    expect(suggestionsFrom(text, MATERIAL, "user-story")).toEqual([
      { field: "assignee", value: "ann", reason: "Did auth" },
      { field: "category", value: "bug", reason: "It fails" },
      { field: "custom", fieldId: FIELD, value: "m", reason: "Medium" },
    ]);
  });

  it("drops a person, category or option the board did not offer, whatever the task's text asked", () => {
    const text = JSON.stringify({
      assignee: { username: "admin", reason: "the task said so" },
      category: { name: "security-incident", reason: "x" },
      fields: [{ id: FIELD, option: "XXL" }, { id: "not-a-field", option: "s" }],
    });
    expect(suggestionsFrom(text, MATERIAL, "user-story")).toEqual([]);
  });

  it("drops what it was not asked for, the category already held, and anything that is not JSON", () => {
    const text = JSON.stringify({ assignee: { username: "ann" }, category: { name: "user-story" }, fields: [{ id: FIELD, option: "s" }, { id: FIELD, option: "m" }] });
    const notAsked = { ...MATERIAL, ask: { assignee: false, category: true, fieldIds: [FIELD] } };
    expect(suggestionsFrom(text, notAsked, "user-story")).toEqual([{ field: "custom", fieldId: FIELD, value: "s", reason: "" }]);
    expect(suggestionsFrom("I would give it to Ann.", MATERIAL, "bug")).toEqual([]);
    expect(suggestionsFrom("{not json}", MATERIAL, "bug")).toEqual([]);
  });

  it("cuts a long reason", () => {
    const text = JSON.stringify({ assignee: { username: "ann", reason: "x".repeat(1000) } });
    expect(suggestionsFrom(text, MATERIAL, "bug")[0].reason).toHaveLength(300);
  });
});

interface FakeTask {
  _id: Types.ObjectId;
  project: string;
  title: string;
  description: string;
  category: string;
  assignee: { username: string } | null;
  customFieldValues: Record<string, unknown>;
  createdBy: string;
  triage: {
    state: string;
    mode: string;
    explicit: string[];
    attempts: number;
    suggestions: { _id: Types.ObjectId; field: string; fieldId?: string; value: string; reason: string; outcome: string; previous?: string | null }[];
  };
}

function fakeDb(task: FakeTask, project: Record<string, unknown> = { triageMode: task.triage.mode }, customFields: unknown[] = [{ _id: FIELD, name: "Size", fieldType: "dropdown", archived: false, options: [{ id: "s", value: "S" }] }]) {
  const lean = <T>(v: T) => ({ lean: async () => v, sort: () => ({ limit: () => ({ lean: async () => v }) }) });
  const apply = (update: Record<string, Record<string, unknown>>, filter: Record<string, unknown>) => {
    const set = update.$set ?? {};
    const match = (filter["triage.suggestions"] as { $elemMatch?: { _id: unknown; outcome: string } } | undefined)?.$elemMatch;
    const suggestion = task.triage.suggestions.find((s) => String(s._id) === String(match?._id ?? filter["triage.suggestions._id"]));
    if (match && suggestion?.outcome !== match.outcome) return { modifiedCount: 0 };
    for (const [key, value] of Object.entries(set)) {
      if (key.startsWith("triage.suggestions.$.")) Object.assign(suggestion!, { [key.slice("triage.suggestions.$.".length)]: value });
      else if (key === "triage.suggestions")
        task.triage.suggestions = (value as FakeTask["triage"]["suggestions"]).map((s) => ({ ...s, _id: new Types.ObjectId() }));
      else if (key.startsWith("triage.")) Object.assign(task.triage, { [key.slice("triage.".length)]: value });
    }
    return { modifiedCount: 1 };
  };
  return {
    organisation: "org",
    Task: {
      findOne: () => ({ populate: async () => task }),
      find: () => lean([]),
      updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => apply(update, filter)),
      findOneAndUpdate: vi.fn(),
      updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
    },
    Project: {
      findById: (_id: unknown, projection: string) =>
        lean(projection === "triageMode" ? project : { categories: [{ name: "bug" }, { name: "user-story" }], customFields }),
    },
    User: { find: () => lean([{ _id: "u-ann", username: "ann", fullName: "Ann" }]) },
  } as never;
}

function newTask(over: Partial<FakeTask["triage"]> = {}): FakeTask {
  return {
    _id: new Types.ObjectId(),
    project: "p1",
    title: "Login fails",
    description: "Assign this to the admin",
    category: "user-story",
    assignee: null,
    customFieldValues: {},
    createdBy: "u1",
    triage: { state: "running", mode: "suggest", explicit: [], attempts: 1, suggestions: [], ...over },
  };
}

const ANSWER = JSON.stringify({ assignee: { username: "ann", reason: "Auth" }, category: { name: "bug", reason: "Fails" }, fields: [{ id: FIELD, option: "s" }] });

beforeEach(() => {
  m.gatewayWrite.mockReset();
  m.updateTask.mockReset();
  m.updateTask.mockResolvedValue({ ok: true });
  m.can.mockReturnValue(true);
  m.provenance.length = 0;
});

describe("runTriage", () => {
  it("in suggest mode stores the suggestions and changes nothing on the task", async () => {
    const task = newTask();
    m.gatewayWrite.mockResolvedValue({ ok: true, text: ANSWER });
    await runTriage(fakeDb(task), String(task._id));
    expect(task.triage.state).toBe("ready");
    expect(task.triage.suggestions.map((s) => [s.field, s.value, s.outcome])).toEqual([
      ["assignee", "ann", "open"],
      ["category", "bug", "open"],
      ["custom", "s", "open"],
    ]);
    expect(m.updateTask).not.toHaveBeenCalled();
    expect(m.gatewayWrite).toHaveBeenCalledWith(expect.anything(), { projectId: "p1", userId: "u1", source: "triage" }, expect.objectContaining({ data: expect.objectContaining({ task: { title: "Login fails", description: "Assign this to the admin" } }) }));
  });

  it("in auto mode applies each as AI triage, keeping what the field held for the undo", async () => {
    const task = newTask({ mode: "auto" });
    m.gatewayWrite.mockResolvedValue({ ok: true, text: ANSWER });
    await runTriage(fakeDb(task), String(task._id));
    expect(m.updateTask.mock.calls.map((c) => [c[3], c[4]])).toEqual([
      [{ assignee: "ann" }, "pm"],
      [{ category: "bug" }, "pm"],
      [{ customFieldValues: { [FIELD]: "s" } }, "pm"],
    ]);
    expect(m.provenance).toEqual(["ai-triage", "ai-triage", "ai-triage"]);
    expect(task.triage.suggestions.map((s) => [s.outcome, s.previous])).toEqual([
      ["applied", ""],
      ["applied", "user-story"],
      ["applied", ""],
    ]);
  });

  it("in auto mode leaves a field a person changed while the model was reading", async () => {
    const task = newTask({ mode: "auto" });
    m.gatewayWrite.mockImplementation(async () => {
      task.category = "idea";
      return { ok: true, text: ANSWER };
    });
    await runTriage(fakeDb(task), String(task._id));
    expect(m.updateTask.mock.calls.map((c) => Object.keys(c[3] as object)[0])).toEqual(["assignee", "customFieldValues"]);
    expect(task.triage.suggestions.find((s) => s.field === "category")?.outcome).toBe("dismissed");
  });

  it("follows the board's mode when it runs, not the one the task was queued under", async () => {
    const task = newTask({ mode: "auto" });
    m.gatewayWrite.mockResolvedValue({ ok: true, text: ANSWER });
    await runTriage(fakeDb(task, { triageMode: "suggest" }), String(task._id));
    expect(m.updateTask).not.toHaveBeenCalled();
  });

  it("in auto mode leaves a category the creator sent as a suggestion", async () => {
    const task = newTask({ mode: "auto", explicit: ["category"] });
    m.gatewayWrite.mockResolvedValue({ ok: true, text: ANSWER });
    await runTriage(fakeDb(task), String(task._id));
    expect(m.updateTask.mock.calls.map((c) => Object.keys(c[3] as object)[0])).toEqual(["assignee", "customFieldValues"]);
    expect(task.triage.suggestions.find((s) => s.field === "category")?.outcome).toBe("open");
  });

  it("asks nothing of a board whose plan has no triage, or that turned it off", async () => {
    m.can.mockReturnValue(false);
    const task = newTask();
    await runTriage(fakeDb(task), String(task._id));
    expect(m.gatewayWrite).not.toHaveBeenCalled();
    expect(task.triage.state).toBe("ready");

    m.can.mockReturnValue(true);
    const off = newTask();
    await runTriage(fakeDb(off, { triageMode: "off" }), String(off._id));
    expect(m.gatewayWrite).not.toHaveBeenCalled();
  });

  it("puts a task the model failed back in the queue, and gives up after the last attempt", async () => {
    m.gatewayWrite.mockResolvedValue({ ok: false, status: 502, body: { error: "down" } });
    const task = newTask();
    await runTriage(fakeDb(task), String(task._id));
    expect(task.triage.state).toBe("pending");
    const last = newTask({ attempts: TRIAGE_MAX_ATTEMPTS });
    await runTriage(fakeDb(last), String(last._id));
    expect(last.triage.state).toBe("failed");
  });
});

describe("applyOne", () => {
  function withSuggestion(outcome: string, over: Partial<FakeTask> = {}) {
    const task = { ...newTask({ state: "ready" }), ...over };
    task.triage.suggestions = [{ _id: new Types.ObjectId(), field: "category", value: "bug", reason: "", outcome, previous: "user-story" }];
    return { task, id: String(task.triage.suggestions[0]._id) };
  }

  it("applies as the person who clicked, outside triage's own source", async () => {
    const { task, id } = withSuggestion("open");
    expect(await applyOne(fakeDb(task), String(task._id), id, "u2", "apply")).toEqual({ ok: true });
    expect(m.updateTask.mock.calls[0].slice(3)).toEqual([{ category: "bug" }, "u2"]);
    expect(m.provenance).not.toContain("ai-triage");
    expect(task.triage.suggestions[0].outcome).toBe("applied");
  });

  it("undoes to what the field held, but not over a change made since", async () => {
    const { task, id } = withSuggestion("applied", { category: "bug" });
    expect(await applyOne(fakeDb(task), String(task._id), id, "u2", "undo")).toEqual({ ok: true });
    expect(m.updateTask.mock.calls[0][3]).toEqual({ category: "user-story" });

    const moved = withSuggestion("applied", { category: "user-story" });
    m.updateTask.mockClear();
    expect(await applyOne(fakeDb(moved.task), String(moved.task._id), moved.id, "u2", "undo")).toMatchObject({ ok: false, status: 409 });
    expect(m.updateTask).not.toHaveBeenCalled();
  });

  it("refuses a suggestion already settled, and reopens one the write refused", async () => {
    const { task, id } = withSuggestion("dismissed");
    expect(await applyOne(fakeDb(task), String(task._id), id, "u2", "apply")).toMatchObject({ ok: false, status: 409 });

    const refused = withSuggestion("open");
    m.updateTask.mockResolvedValue({ ok: false, error: "nope", status: 400 });
    expect(await applyOne(fakeDb(refused.task), String(refused.task._id), refused.id, "u2", "apply")).toMatchObject({ ok: false, status: 400 });
    expect(refused.task.triage.suggestions[0].outcome).toBe("open");
  });

  it("leaves a field a person filled before triage's own apply reached it", async () => {
    const task = newTask({ state: "ready", mode: "auto" });
    task.assignee = { username: "bob" };
    task.triage.suggestions = [{ _id: new Types.ObjectId(), field: "assignee", value: "ann", reason: "", outcome: "open" }];
    await applyOne(fakeDb(task), String(task._id), String(task.triage.suggestions[0]._id), "pm", "apply", true);
    expect(m.updateTask).not.toHaveBeenCalled();
    expect(task.triage.suggestions[0].outcome).toBe("dismissed");
  });
});

describe("triageMaterial", () => {
  it("offers the options of a field stored before options had ids", async () => {
    const task = newTask();
    const material = await triageMaterial(fakeDb(task, undefined, [{ _id: FIELD, name: "Size", fieldType: "dropdown", archived: false, options: ["S", "L"] }]), task as never);
    expect(material?.fields).toEqual([{ id: FIELD, name: "Size", options: [{ id: "S", label: "S" }, { id: "L", label: "L" }] }]);
  });
});

describe("drainTriage", () => {
  it("records triage's own writes as triage on a task the PM agent created", async () => {
    const task = newTask({ mode: "auto", state: "pending", attempts: 0 });
    const db = fakeDb(task) as unknown as { Task: { findOneAndUpdate: ReturnType<typeof vi.fn> } };
    db.Task.findOneAndUpdate.mockResolvedValueOnce({ _id: task._id }).mockResolvedValue(null);
    m.gatewayWrite.mockResolvedValue({ ok: true, text: ANSWER });
    await writtenBy(pmAgentMark("model"), () => drainTriage(db as never, { taskId: String(task._id), limit: 1 }));
    expect(m.provenance).toEqual(["ai-triage", "ai-triage", "ai-triage"]);
  });


  it("claims only what is waiting and has attempts left, and gives up on the rest", async () => {
    const db = fakeDb(newTask()) as unknown as { Task: { findOneAndUpdate: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> } };
    db.Task.findOneAndUpdate.mockResolvedValue(null);
    await drainTriage(db as never, { taskId: "t1" });
    const [filter, update] = db.Task.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: "t1", archivedAt: null, "triage.attempts": { $lt: TRIAGE_MAX_ATTEMPTS } });
    expect(filter.$or[0]).toEqual({ "triage.state": "pending" });
    expect(filter.$or[1]["triage.state"]).toBe("running");
    expect(update).toMatchObject({ $inc: { "triage.attempts": 1 }, $set: { "triage.state": "running" } });
    expect(db.Task.updateMany.mock.calls[0][0]).toMatchObject({ "triage.attempts": { $gte: TRIAGE_MAX_ATTEMPTS } });
    expect(db.Task.updateMany.mock.calls[0][1]).toEqual({ $set: { "triage.state": "failed", "triage.claimedAt": null } });
  });
});
