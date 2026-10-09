import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  resolveModelKey: vi.fn(),
  checkBudget: vi.fn(),
  counterKindOf: vi.fn(),
  recordUsage: vi.fn(),
  chatCompletion: vi.fn(),
}));

vi.mock("@/lib/model-keys", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/model-keys")>()), resolveModelKey: m.resolveModelKey }));
vi.mock("./budget", () => ({ checkBudget: m.checkBudget, counterKindOf: m.counterKindOf }));
vi.mock("./usage", () => ({ recordUsage: m.recordUsage }));
vi.mock("@/lib/pm/openrouter", () => ({ chatCompletion: m.chatCompletion }));
vi.mock("@/lib/organisation-host", () => ({ organisationDomain: () => "board-planner.com" }));

const { gatewayAssist, gatewayChat, openGate } = await import("./index");

const db = { organisation: "org" } as never;
const NOT_CONFIGURED = { error: "AI is not configured", status: 501 };
const USAGE = { promptTokens: 9, completionTokens: 1, totalTokens: 10, cachedPromptTokens: 0, cacheWriteTokens: 0 };
const CHAT = { model: "m/x", messages: [], tools: [] };
const CONTEXT = { source: "pm" as const, projectId: "p1", userId: "u1" };

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.resolveModelKey.mockResolvedValue({ ok: true, key: "sk-ours", source: "managed" });
  m.checkBudget.mockResolvedValue({ refusal: null, counter: "month" });
  m.counterKindOf.mockResolvedValue("month");
  m.recordUsage.mockResolvedValue(undefined);
});

// BP-679 / BP-680 / BP-681: the one door to a model
describe("openGate", () => {
  it("opens with the key and the counter a call is added to, after asking the budget of the operator's key", async () => {
    expect(await openGate(db, NOT_CONFIGURED)).toEqual({ ok: true, key: "sk-ours", keySource: "managed", counter: "month" });
    expect(m.checkBudget).toHaveBeenCalledTimes(1);
  });

  it("opens on the counter the budget says a call is added to: a trial's own, not the month", async () => {
    m.checkBudget.mockResolvedValue({ refusal: null, counter: "trial" });

    expect(await openGate(db, NOT_CONFIGURED)).toMatchObject({ ok: true, counter: "trial" });
  });

  it("never asks the budget about an organisation's own key, which it pays for, and counts it all the same", async () => {
    m.resolveModelKey.mockResolvedValue({ ok: true, key: "sk-theirs", source: "own" });
    m.counterKindOf.mockResolvedValue("trial");

    expect(await openGate(db, NOT_CONFIGURED)).toEqual({ ok: true, key: "sk-theirs", keySource: "own", counter: "trial" });
    expect(m.checkBudget).not.toHaveBeenCalled();
  });

  it("refuses with 429, naming the limit, the counter and the reset, once the operator's key has been spent", async () => {
    m.checkBudget.mockResolvedValue({ counter: "month", refusal: { scope: "month", used: 15, limit: 15, resetsAt: new Date("2026-11-01T00:00:00Z") } });

    const gate = await openGate(db, NOT_CONFIGURED);

    expect(gate).toMatchObject({ ok: false, status: 429, body: { reason: "ai_budget", scope: "month", used: 15, limit: 15, resetsAt: "2026-11-01T00:00:00.000Z" } });
    expect((gate as { error: string }).error).toMatch(/15 of 15 AI tokens.*1 November 2026/);
  });

  it("passes on what the plan or the key said where the key is not to be had, without looking at the budget", async () => {
    m.resolveModelKey.mockResolvedValue({ ok: false, reason: "needs_plan", plan: "free" });

    expect(await openGate(db, NOT_CONFIGURED)).toMatchObject({ ok: false, status: 402, body: { reason: "needs_plan", feature: "ai.managed" } });
    expect(m.checkBudget).not.toHaveBeenCalled();
  });
});

describe("gatewayChat", () => {
  it("answers a refused call with an error and never reaches the provider", async () => {
    m.checkBudget.mockResolvedValue({ counter: "month", refusal: { scope: "day", used: 5, limit: 5, resetsAt: new Date("2026-10-10T00:00:00Z") } });

    const completion = await gatewayChat(db, CONTEXT, CHAT);

    expect(completion).toMatchObject({ type: "error", refused: true, error: expect.stringMatching(/paused for today/) });
    expect(m.chatCompletion).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("makes the call with the key the gate opened and records what it cost, with who asked and for which project", async () => {
    m.chatCompletion.mockResolvedValue({ type: "text", content: "hi", usage: USAGE });

    const completion = await gatewayChat(db, CONTEXT, CHAT);

    expect(completion).toMatchObject({ type: "text" });
    expect(m.chatCompletion).toHaveBeenCalledWith({ ...CHAT, apiKey: "sk-ours" });
    expect(m.recordUsage).toHaveBeenCalledWith(db, { source: "pm", projectId: "p1", userId: "u1", keySource: "managed", model: "m/x", usage: USAGE }, "month");
  });

  it("records a call that asked for tools too, and one the provider reported no usage for", async () => {
    m.chatCompletion.mockResolvedValue({ type: "tool_calls", content: "", calls: [], assistantMessage: {} });

    await gatewayChat(db, CONTEXT, CHAT);

    expect(m.recordUsage).toHaveBeenCalledWith(db, expect.objectContaining({ usage: undefined }), "month");
  });

  it("records nothing for a call the provider refused, and does not call it a refusal of the gate's", async () => {
    m.chatCompletion.mockResolvedValue({ type: "error", error: "HTTP 500" });

    const completion = await gatewayChat(db, CONTEXT, CHAT);

    expect(completion).toEqual({ type: "error", error: "HTTP 500" });
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("counts a call that was stopped at the size of what was sent, because the provider bills a request it was sent", async () => {
    m.chatCompletion.mockResolvedValue({ type: "aborted" });
    const messages = [{ role: "user", content: "x".repeat(100) }];

    const completion = await gatewayChat(db, CONTEXT, { ...CHAT, messages });

    expect(completion).toEqual({ type: "aborted" });
    expect(m.recordUsage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ source: "pm", keySource: "managed", usage: { promptTokens: 33, completionTokens: 0, totalTokens: 33, cachedPromptTokens: 0, cacheWriteTokens: 0 } }),
      "month"
    );
  });

  it("gives the answer even when writing it down failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.chatCompletion.mockResolvedValue({ type: "text", content: "hi", usage: USAGE });
    m.recordUsage.mockRejectedValue(new Error("db down"));

    expect(await gatewayChat(db, CONTEXT, CHAT)).toMatchObject({ type: "text", content: "hi" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("gatewayAssist", () => {
  const gate = { ok: true as const, key: "sk-ours", keySource: "managed" as const, counter: "month" as const };
  const ASSIST = { source: "assist" as const, projectId: "p1", userId: "u1" };

  it("hands the call the key and records what it reported", async () => {
    const result = await gatewayAssist(db, ASSIST, gate, "m/x", async (key, report) => {
      report(USAGE);
      return `made with ${key}`;
    });

    expect(result).toBe("made with sk-ours");
    expect(m.recordUsage).toHaveBeenCalledWith(db, { source: "assist", projectId: "p1", userId: "u1", keySource: "managed", model: "m/x", usage: USAGE }, "month");
  });

  it("still records a generation that was answered and then failed, because it was billed, and rethrows", async () => {
    await expect(
      gatewayAssist(db, ASSIST, gate, "m/x", async (_key, report) => {
        report(USAGE);
        throw new Error("the answer was not JSON");
      })
    ).rejects.toThrow("the answer was not JSON");

    expect(m.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a call that failed before the provider answered", async () => {
    await expect(gatewayAssist(db, ASSIST, gate, "m/x", async () => Promise.reject(new Error("no route to host")))).rejects.toThrow("no route");

    expect(m.recordUsage).not.toHaveBeenCalled();
  });
});
