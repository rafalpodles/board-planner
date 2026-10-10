import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  resolveModelKey: vi.fn(),
  checkBudget: vi.fn(),
  counterKindOf: vi.fn(),
  recordUsage: vi.fn(),
  chatCompletion: vi.fn(),
  getOrganisation: vi.fn(),
}));

vi.mock("@/lib/model-keys", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/model-keys")>()), resolveModelKey: m.resolveModelKey }));
vi.mock("./budget", () => ({ checkBudget: m.checkBudget, counterKindOf: m.counterKindOf }));
vi.mock("./usage", () => ({ recordUsage: m.recordUsage }));
vi.mock("@/lib/organisation", () => ({ getOrganisation: m.getOrganisation }));
vi.mock("@/lib/pm/openrouter", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/pm/openrouter")>()), chatCompletion: m.chatCompletion }));
vi.mock("@/lib/organisation-host", () => ({ organisationDomain: () => "board-planner.com" }));

const { gatewayAssist, gatewayChat, openGate, UnmanagedModelRefused } = await import("./index");

const db = { organisation: "org" } as never;
const NOT_CONFIGURED = { error: "AI is not configured", status: 501 };
const USAGE = { promptTokens: 9, completionTokens: 1, totalTokens: 10, cachedPromptTokens: 0, cacheWriteTokens: 0 };
const CHAT = { model: "openai/x", messages: [], tools: [] };
const CONTEXT = { source: "pm" as const, projectId: "p1", userId: "u1" };

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.resolveModelKey.mockResolvedValue({ ok: true, key: "sk-ours", source: "managed" });
  m.checkBudget.mockResolvedValue({ refusal: null, counter: "month" });
  m.counterKindOf.mockResolvedValue("month");
  m.recordUsage.mockResolvedValue(undefined);
  m.getOrganisation.mockResolvedValue({ aiLockedAt: null, aiLockedReason: "" });
});

// BP-679 / BP-680 / BP-681: the one door to a model
describe("openGate", () => {
  it("opens with the key and the counter a call is added to, after asking the budget of the operator's key", async () => {
    expect(await openGate(db, NOT_CONFIGURED)).toEqual({ ok: true, key: "sk-ours", keySource: "managed", counter: "month" });
    expect(m.checkBudget).toHaveBeenCalledTimes(1);
  });

  // BP-680: the operator's lock is about the operator's key, so it is read where that key is about to be used
  it("refuses with 403 and says the operator switched it off, once the operator has, without asking the budget", async () => {
    m.getOrganisation.mockResolvedValue({ aiLockedAt: new Date(), aiLockedReason: "abuse report 17" });

    const gate = await openGate(db, NOT_CONFIGURED);

    expect(gate).toMatchObject({ ok: false, status: 403, body: { reason: "ai_locked" } });
    expect((gate as { error: string }).error).toMatch(/switched off for this organisation by the operator: abuse report 17.*Add your own key/);
    expect(m.checkBudget).not.toHaveBeenCalled();
  });

  it("does not let the lock touch an organisation's own key, which the operator does not pay for", async () => {
    m.getOrganisation.mockResolvedValue({ aiLockedAt: new Date(), aiLockedReason: "" });
    m.resolveModelKey.mockResolvedValue({ ok: true, key: "sk-theirs", source: "own" });

    expect(await openGate(db, NOT_CONFIGURED)).toMatchObject({ ok: true, key: "sk-theirs", keySource: "own" });
  });

  it("does not read the lock for a self-hosted instance's own key: it is the owner's, not the operator's", async () => {
    m.getOrganisation.mockResolvedValue({ aiLockedAt: new Date(), aiLockedReason: "" });
    m.resolveModelKey.mockResolvedValue({ ok: true, key: "sk-instance", source: "instance" });

    expect(await openGate(db, NOT_CONFIGURED)).toMatchObject({ ok: true, keySource: "instance" });
  });

  it("stops a PM round-trip at the lock and never reaches the provider", async () => {
    m.getOrganisation.mockResolvedValue({ aiLockedAt: new Date(), aiLockedReason: "" });

    expect(await gatewayChat(db, CONTEXT, CHAT)).toMatchObject({ type: "error", error: expect.stringMatching(/switched off/) });
    expect(m.chatCompletion).not.toHaveBeenCalled();
  });

  it("opens on the counter the budget says a call is added to: a trial's own, not the month", async () => {
    m.checkBudget.mockResolvedValue({ refusal: null, counter: "trial" });

    expect(await openGate(db, NOT_CONFIGURED)).toMatchObject({ ok: true, counter: "trial" });
  });

  // BP-681: our key is never somebody's fallback, because the key is what we pay for
  it("closes the gate on a stored key that cannot be read: no call, no look at the budget", async () => {
    m.resolveModelKey.mockResolvedValue({ ok: false, reason: "own_key_unreadable", plan: "pro" });

    const gate = await openGate(db, NOT_CONFIGURED);
    const completion = await gatewayChat(db, CONTEXT, CHAT);

    expect(gate).toMatchObject({ ok: false, status: 503, body: { reason: "own_key_unreadable" } });
    expect(completion).toMatchObject({ type: "error" });
    expect(m.chatCompletion).not.toHaveBeenCalled();
    expect(m.checkBudget).not.toHaveBeenCalled();
  });

  it("makes a call on an own key with that key once, and does not try ours when it fails", async () => {
    m.resolveModelKey.mockResolvedValue({ ok: true, key: "sk-theirs", source: "own" });
    m.chatCompletion.mockResolvedValue({ type: "error", error: "HTTP 401" });

    const completion = await gatewayChat(db, CONTEXT, CHAT);

    expect(completion).toEqual({ type: "error", error: "HTTP 401" });
    expect(m.chatCompletion).toHaveBeenCalledTimes(1);
    expect(m.chatCompletion).toHaveBeenCalledWith({ ...CHAT, apiKey: "sk-theirs" });
    expect(m.checkBudget).not.toHaveBeenCalled();
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

    expect(completion).toMatchObject({ type: "error", error: expect.stringMatching(/paused for today/) });
    expect(m.chatCompletion).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("makes the call with the key the gate opened and records what it cost, with who asked and for which project", async () => {
    m.chatCompletion.mockResolvedValue({ type: "text", content: "hi", usage: USAGE });

    const completion = await gatewayChat(db, CONTEXT, CHAT);

    expect(completion).toMatchObject({ type: "text" });
    expect(m.chatCompletion).toHaveBeenCalledWith({ ...CHAT, apiKey: "sk-ours", provider: { data_collection: "deny", only: ["openai"] } });
    expect(m.recordUsage).toHaveBeenCalledWith(db, { source: "pm", projectId: "p1", userId: "u1", keySource: "managed", model: "openai/x", usage: USAGE }, "month");
  });

  it("holds the platform's key to the providers the sub-processor list names, and leaves any other key to its own settings", async () => {
    m.chatCompletion.mockResolvedValue({ type: "text", content: "hi", usage: USAGE });
    await gatewayChat(db, CONTEXT, { ...CHAT, model: "openai/gpt-6-luna" });
    m.resolveModelKey.mockResolvedValue({ ok: true, key: "sk-instance", source: "instance" });
    await gatewayChat(db, CONTEXT, CHAT);

    expect(m.chatCompletion.mock.calls[0][0].provider).toEqual({ data_collection: "deny", only: ["openai"] });
    expect(m.chatCompletion.mock.calls[1][0]).not.toHaveProperty("provider");
  });

  it("records a call that asked for tools too, and one the provider reported no usage for", async () => {
    m.chatCompletion.mockResolvedValue({ type: "tool_calls", content: "", calls: [], assistantMessage: {} });

    await gatewayChat(db, CONTEXT, CHAT);

    expect(m.recordUsage).toHaveBeenCalledWith(db, expect.objectContaining({ usage: undefined }), "month");
  });

  it("records nothing for a call the provider refused", async () => {
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

  it("counts a stopped call's images at a flat figure each, not at the length of the base64 they travel as", async () => {
    m.chatCompletion.mockResolvedValue({ type: "aborted" });
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(100) },
          { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(4_000_000)}` } },
        ],
      },
    ];

    await gatewayChat(db, CONTEXT, { ...CHAT, messages });

    const text = JSON.stringify(messages, (_key, value) => (typeof value === "string" && value.startsWith("data:") ? "" : value));
    expect(m.recordUsage.mock.calls[0][1].usage.totalTokens).toBe(Math.ceil(text.length / 4) + 1500);
  });

  it("counts a message that merely starts with data: as the text it is", async () => {
    m.chatCompletion.mockResolvedValue({ type: "aborted" });

    await gatewayChat(db, CONTEXT, { ...CHAT, messages: [{ role: "user", content: "data: the export failed" }] });

    expect(m.recordUsage.mock.calls[0][1].usage.totalTokens).toBeLessThan(100);
  });

  it("counts nothing for a call that was stopped before it was sent, and never reaches the provider", async () => {
    m.chatCompletion.mockResolvedValue({ type: "aborted" });
    const stopped = new AbortController();
    stopped.abort();

    expect(await gatewayChat(db, CONTEXT, { ...CHAT, signal: stopped.signal })).toEqual({ type: "aborted" });

    expect(m.chatCompletion).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
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
    const result = await gatewayAssist(db, ASSIST, gate, "openai/x", async (key, report) => {
      report(USAGE);
      return `made with ${key}`;
    });

    expect(result).toBe("made with sk-ours");
    expect(m.recordUsage).toHaveBeenCalledWith(db, { source: "assist", projectId: "p1", userId: "u1", keySource: "managed", model: "openai/x", usage: USAGE }, "month");
  });

  it("still records a generation that was answered and then failed, because it was billed, and rethrows", async () => {
    await expect(
      gatewayAssist(db, ASSIST, gate, "openai/x", async (_key, report) => {
        report(USAGE);
        throw new Error("the answer was not JSON");
      })
    ).rejects.toThrow("the answer was not JSON");

    expect(m.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a call that failed before the provider answered", async () => {
    await expect(gatewayAssist(db, ASSIST, gate, "openai/x", async () => Promise.reject(new Error("no route to host")))).rejects.toThrow("no route");

    expect(m.recordUsage).not.toHaveBeenCalled();
  });
});

// BP-1001: the platform's key runs the models the operator allows on it, and is refused before anything is sent for any other
describe("models on the platform's key", () => {
  const ASSIST = { source: "assist" as const, projectId: "p1", userId: "u1" };
  const managed = { ok: true as const, key: "sk-ours", keySource: "managed" as const, counter: "month" as const };

  beforeEach(() => {
    m.chatCompletion.mockResolvedValue({ type: "text", content: "hi", usage: USAGE });
  });

  it("refuses a PM round-trip with a model off the list, saying which ones run and that an own key runs any, and never reaches the provider", async () => {
    const completion = await gatewayChat(db, CONTEXT, { ...CHAT, model: "moonshotai/kimi-k2.6" });

    expect(completion).toEqual({
      type: "error",
      error:
        "The model moonshotai/kimi-k2.6 is not available on Board Planner's AI key. Choose one of: OpenAI's own models (openai/…, not gpt-oss), or add your organisation's own OpenRouter key in Settings → AI key.",
    });
    expect(m.chatCompletion).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("refuses at the gate with 403 and the model, for a caller that names it", async () => {
    expect(await openGate(db, NOT_CONFIGURED, "openai/gpt-oss-120b")).toMatchObject({
      ok: false,
      status: 403,
      body: { reason: "model_not_managed", model: "openai/gpt-oss-120b", error: expect.stringMatching(/^The model openai\/gpt-oss-120b is not available/) },
    });
    expect(await openGate(db, NOT_CONFIGURED, "openai/gpt-6-luna")).toMatchObject({ ok: true, keySource: "managed" });
  });

  it("lets the default PM model through on the platform's key", async () => {
    expect(await gatewayChat(db, CONTEXT, { ...CHAT, model: "openai/gpt-6-luna" })).toMatchObject({ type: "text" });
    expect(m.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("runs any model on an organisation's own key and on a self-hosted instance's", async () => {
    for (const source of ["own", "instance"]) {
      m.resolveModelKey.mockResolvedValue({ ok: true, key: `sk-${source}`, source });
      expect(await gatewayChat(db, CONTEXT, { ...CHAT, model: "moonshotai/kimi-k2.6" })).toMatchObject({ type: "text" });
    }
    expect(m.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it("refuses an AI Assist generation with a model off the list before the call is made", async () => {
    const call = vi.fn();

    const refused = gatewayAssist(db, ASSIST, managed, "anthropic/claude-haiku", call);

    await expect(refused).rejects.toBeInstanceOf(UnmanagedModelRefused);
    await expect(refused).rejects.toMatchObject({ gate: { status: 403, body: { reason: "model_not_managed", model: "anthropic/claude-haiku" } } });
    expect(call).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("reads AI Assist's bare default as the OpenAI model it is, and lets it through", async () => {
    expect(await gatewayAssist(db, ASSIST, managed, "gpt-4o-mini", async () => "made")).toBe("made");
  });

  it("runs any AI Assist model on an organisation's own key", async () => {
    expect(await gatewayAssist(db, ASSIST, { ...managed, keySource: "own" }, "anthropic/claude-haiku", async () => "made")).toBe("made");
  });
});
