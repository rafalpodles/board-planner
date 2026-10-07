import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const generateTask = vi.fn();
const projectFindOne = vi.fn();
const resolveModelKey = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/ai", () => ({ generateTask }));
vi.mock("@/lib/model-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-keys")>()),
  resolveModelKey,
}));
vi.mock("@/lib/ai-fields", () => ({ choiceFieldsForPrompt: () => [], resolveGeneratedFields: () => ({}) }));
vi.mock("@/models/settings", () => ({ getSettings: async () => ({ aiModel: "m" }) }));
vi.mock("@/models/project", () => ({ Project: { findOne: projectFindOne } }));
const taskFind = vi.fn((..._args: unknown[]) => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));
vi.mock("@/lib/middleware", async () => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    withProjectAccess:
      (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
      (req: Request, ctx: { user?: unknown }) =>
        handler(req, { ...ctx, user: ctx.user ?? { _id: "u1" }, db: scopedToDefaultOrganisation() }),
  };
});

const { GET, POST, MAX_PROMPT_LENGTH, GENERATIONS_PER_USER_WINDOW } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

function generate(prompt: unknown, userId = "u1", projectId = "p1") {
  return POST(
    new Request("https://app.example.com/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }),
    { params: Promise.resolve({ projectId }), user: { _id: userId } } as never
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  projectFindOne.mockResolvedValue({ name: "Board", description: "", customFields: [], categories: [] });
  generateTask.mockResolvedValue({ title: "T", fields: {} });
  resolveModelKey.mockResolvedValue({ ok: true, key: "sk-the-orgs-key", source: "own" });
});

afterEach(() => {
  delete process.env.AI_DAILY_GENERATION_CAP;
});

// BP-323: the PM chat beside this route had a length cap, a throttle, a daily cap and a lock; this
// one shipped any prompt to the instance's OpenAI key as often as it was asked
// BP-652. Whose key a generation is spent on is decided per organisation, before anything is counted
describe("which key generate-task spends", () => {
  it("makes the call with the key it resolved for this organisation", async () => {
    await generate("a task");

    expect(resolveModelKey).toHaveBeenCalledWith(expect.anything(), "openai");
    expect(generateTask.mock.calls[0][3]).toBe("sk-the-orgs-key");
  });

  it("answers 402 when the plan has no managed AI and there is no key of its own, and generates nothing", async () => {
    resolveModelKey.mockResolvedValue({ ok: false, reason: "needs_plan", plan: "free" });

    const res = await generate("a task");

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ feature: "ai.managed", plan: "free" });
    expect(generateTask).not.toHaveBeenCalled();
  });

  it("keeps answering 501 where nothing is configured at all", async () => {
    resolveModelKey.mockResolvedValue({ ok: false, reason: "not_configured", plan: "free" });

    expect((await generate("a task")).status).toBe(501);
  });

  it("tells the form whether the feature is on, and whether a plan would turn it on", async () => {
    const ask = () => GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ projectId: "p1" }) } as never);
    expect(await (await ask()).json()).toEqual({ enabled: true, needsPlan: false });

    resolveModelKey.mockResolvedValue({ ok: false, reason: "needs_plan", plan: "free" });
    expect(await (await ask()).json()).toEqual({ enabled: false, needsPlan: true });

    resolveModelKey.mockResolvedValue({ ok: false, reason: "not_configured", plan: "free" });
    expect(await (await ask()).json()).toEqual({ enabled: false, needsPlan: false });
  });
});

describe("POST generate-task", () => {
  it("refuses a prompt past the length cap without spending anything", async () => {
    const res = await generate("p".repeat(MAX_PROMPT_LENGTH + 1));

    expect(res.status).toBe(400);
    expect(generateTask).not.toHaveBeenCalled();
  });

  it("tells the model about the board's live tasks, not the archived ones", async () => {
    await generate("a task");

    expect(taskFind.mock.calls[0][0]).toMatchObject({ project: "p1", archivedAt: null });
  });

  it("generates for a prompt at the cap", async () => {
    const res = await generate("p".repeat(MAX_PROMPT_LENGTH));

    expect(res.status).toBe(200);
    expect(generateTask).toHaveBeenCalledTimes(1);
  });

  it("throttles one person, and counts a failed generation as spent", async () => {
    generateTask.mockRejectedValue(new Error("upstream"));
    for (let i = 0; i < GENERATIONS_PER_USER_WINDOW; i++) {
      expect((await generate("a task")).status).toBe(500);
    }

    const res = await generate("a task");

    expect(res.status).toBe(429);
    expect(generateTask).toHaveBeenCalledTimes(GENERATIONS_PER_USER_WINDOW);
    // Somebody else is not held back by it
    generateTask.mockResolvedValue({ title: "T", fields: {} });
    expect((await generate("a task", "u2")).status).toBe(200);
  });

  it("stops a project at its daily cap, whoever asks", async () => {
    process.env.AI_DAILY_GENERATION_CAP = "3";
    for (const who of ["u1", "u2", "u3"]) expect((await generate("a task", who)).status).toBe(200);

    const res = await generate("a task", "u4");

    expect(res.status).toBe(429);
    expect(generateTask).toHaveBeenCalledTimes(3);
    // Another project has its own day
    expect((await generate("a task", "u4", "p2")).status).toBe(200);
  });

  it("runs one generation per person at a time", async () => {
    let finish!: (v: unknown) => void;
    generateTask.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const first = generate("a task");
    await vi.waitFor(() => expect(generateTask).toHaveBeenCalledTimes(1));
    const second = await generate("another");

    expect(second.status).toBe(409);
    finish({ title: "T", fields: {} });
    expect((await first).status).toBe(200);
    expect((await generate("a third")).status).toBe(200);
  });

  it("lets one of a burst from the same person through, not all of them", async () => {
    let finish!: (v: unknown) => void;
    generateTask.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const burst = Array.from({ length: 5 }, () => generate("a task"));
    await vi.waitFor(() => expect(generateTask).toHaveBeenCalledTimes(1));
    finish({ title: "T", fields: {} });
    const statuses = (await Promise.all(burst)).map((r) => r.status).sort();

    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    expect(generateTask).toHaveBeenCalledTimes(1);
  });

  it("holds a daily cap to a burst from many people at once", async () => {
    process.env.AI_DAILY_GENERATION_CAP = "3";

    const statuses = (await Promise.all(["a", "b", "c", "d", "e", "f"].map((who) => generate("a task", who)))).map(
      (r) => r.status
    );

    expect(statuses.filter((s) => s === 200), JSON.stringify(statuses)).toHaveLength(3);
    expect(generateTask).toHaveBeenCalledTimes(3);
  });

  it("keeps the project's cap for a day, not for the throttle's fifteen minutes", async () => {
    process.env.AI_DAILY_GENERATION_CAP = "1";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-16T08:00:00Z"));
      expect((await generate("a task", "u1")).status).toBe(200);

      vi.setSystemTime(new Date("2026-09-16T09:00:00Z"));
      expect((await generate("a task", "u2")).status).toBe(429);

      vi.setSystemTime(new Date("2026-09-17T08:01:00Z"));
      expect((await generate("a task", "u3")).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
