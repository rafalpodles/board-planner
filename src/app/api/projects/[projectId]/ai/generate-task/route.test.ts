import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTask = vi.fn();
const projectFindOne = vi.fn();
const resolveModelKey = vi.hoisted(() => vi.fn());
const modelKeyAvailability = vi.hoisted(() => vi.fn());

// The gateway's counters are its own tests' business (src/lib/ai-gateway): these only need the door to open
const checkBudget = vi.hoisted(() => vi.fn(async () => ({ refusal: null as unknown, counter: "month" })));
vi.mock("@/lib/ai-gateway/budget", () => ({ counterKindOf: async () => "month", checkBudget }));
const recordUsage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai-gateway/usage", () => ({ recordUsage }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/ai", () => ({ generateTask }));
vi.mock("@/lib/model-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-keys")>()),
  resolveModelKey,
  modelKeyAvailability,
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

// BP-652. Whose key a generation is spent on is decided per organisation, before anything is counted
describe("which key generate-task spends", () => {
  it("makes the call with the key it resolved for this organisation", async () => {
    await generate("a task");

    expect(resolveModelKey).toHaveBeenCalledWith(expect.anything());
    expect(generateTask.mock.calls[0][3]).toBe("sk-the-orgs-key");
  });

  it("answers 429 with the number and the renewal when the organisation has used its AI allowance, and generates nothing", async () => {
    resolveModelKey.mockResolvedValue({ ok: true, key: "sk-ours", source: "managed" });
    checkBudget.mockResolvedValueOnce({ refusal: { scope: "month", used: 15_000_000, limit: 15_000_000, resetsAt: new Date("2026-11-01T00:00:00Z") }, counter: "month" });

    const res = await generate("a task");

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ reason: "ai_budget", scope: "month", used: 15_000_000, limit: 15_000_000, resetsAt: "2026-11-01T00:00:00.000Z" });
    expect(generateTask).not.toHaveBeenCalled();
  });

  it("records what the generation cost for the project and for the person who asked, as AI Assist's", async () => {
    generateTask.mockImplementation(async (...args: unknown[]) => {
      (args[4] as (usage: unknown) => void)({ promptTokens: 9, completionTokens: 1, totalTokens: 10, cachedPromptTokens: 0, cacheWriteTokens: 0 });
      return { title: "T", fields: {} };
    });

    await generate("a task", "u7", "p1");

    expect(recordUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: "assist", projectId: "p1", userId: "u7", keySource: "own" }), "month");
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

    const res = await generate("a task");

    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain("OPENROUTER_API_KEY");
  });

  it("tells the form whether the feature is on, whether a plan would turn it on, and whether a stored key is broken", async () => {
    const ask = () => GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ projectId: "p1" }) } as never);
    modelKeyAvailability.mockResolvedValue({ available: true, needsPlan: false, unreadable: false });
    expect(await (await ask()).json()).toEqual({ enabled: true, needsPlan: false, keyUnreadable: false });

    modelKeyAvailability.mockResolvedValue({ available: false, needsPlan: true, unreadable: false });
    expect(await (await ask()).json()).toEqual({ enabled: false, needsPlan: true, keyUnreadable: false });

    modelKeyAvailability.mockResolvedValue({ available: false, needsPlan: false, unreadable: true });
    expect(await (await ask()).json()).toEqual({ enabled: false, needsPlan: false, keyUnreadable: true });

    expect(modelKeyAvailability).toHaveBeenCalledWith(expect.anything());
  });
});

// BP-323: the PM chat beside this route had a length cap, a throttle, a daily cap and a lock; this
// one shipped any prompt to the instance's key as often as it was asked
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

  // BP-679: what a project may spend is the organisation's token allowance, counted by the gateway, not a number of generations
  it("puts no count of generations on a project: many people in a day all get one", async () => {
    const people = Array.from({ length: 250 }, (_, n) => `person-${n}`);
    const statuses: number[] = [];
    for (const who of people) statuses.push((await generate("a task", who)).status);

    expect(new Set(statuses)).toEqual(new Set([200]));
    expect(generateTask).toHaveBeenCalledTimes(250);
  });
});
