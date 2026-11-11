import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPlannerTools } from "./tools";
import { PlannerClient, readPmTurn } from "./planner-client";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;

function tools() {
  const found = new Map<string, Handler>();
  registerPlannerTools({ registerTool: (name: string, _config: unknown, handler: Handler) => found.set(name, handler) } as unknown as McpServer);
  return found;
}

const extra = { authInfo: { token: "cp_x", extra: { baseUrl: "https://board.example.com" } } };
const run = async (name: string, args: Record<string, unknown>) => JSON.parse((await tools().get(name)!(args, extra)).content[0].text);
const spy = <K extends keyof PlannerClient>(method: K) => vi.spyOn(PlannerClient.prototype, method as never) as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  spy("getProjectByKey").mockResolvedValue({ _id: "p1", key: "BP" });
  spy("resolveTaskKey").mockResolvedValue({ projectId: "p1", taskId: "t1" });
  spy("listSprints").mockResolvedValue([{ _id: "64b000000000000000000009", name: "Sprint 4", status: "active" }]);
});

describe("triage_task", () => {
  const TRIAGE = {
    state: "done",
    mode: "suggest",
    suggestions: [{ _id: "s1", field: "priority", value: "high", reason: "outage", outcome: "pending" }],
  };

  it("reads without an action, and acts on one suggestion with one", async () => {
    const read = spy("getTriage").mockResolvedValue({ triage: TRIAGE });
    const act = spy("actOnTriage").mockResolvedValue({ triage: { ...TRIAGE, suggestions: [{ ...TRIAGE.suggestions[0], outcome: "applied" }] } });

    expect((await run("triage_task", { taskKey: "bp-3" })).triage.suggestions[0]).toMatchObject({ id: "s1", outcome: "pending" });
    expect((await run("triage_task", { taskKey: "BP-3", suggestion: "s1", action: "apply" })).triage.suggestions[0].outcome).toBe("applied");

    expect(read).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith("p1", "t1", "s1", "apply");
  });

  it("refuses half an action rather than reading in its place", async () => {
    const act = spy("actOnTriage");
    const read = spy("getTriage");

    await expect(run("triage_task", { taskKey: "BP-3", action: "apply" })).rejects.toThrow(/Name both suggestion and action/);
    expect(act).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("release_notes and get_insights", () => {
  it("name a sprint by its name and send its id", async () => {
    const notes = spy("releaseNotes").mockResolvedValue({ markdown: "m" });
    const insights = spy("getInsights").mockResolvedValue({});

    await run("release_notes", { project: "BP", sprint: "sprint 4", tone: "customer" });
    await run("get_insights", { project: "BP", sprint: "Sprint 4", weeks: 4 });

    expect(notes).toHaveBeenCalledWith("p1", { sprintId: "64b000000000000000000009", tone: "customer" });
    expect(insights).toHaveBeenCalledWith("p1", { weeks: "4", sprint: "64b000000000000000000009" });
  });

  it("send a window of days when no sprint is named", async () => {
    const notes = spy("releaseNotes").mockResolvedValue({ markdown: "m" });

    await run("release_notes", { project: "BP", from: "2026-11-01", to: "2026-11-10" });

    expect(notes).toHaveBeenCalledWith("p1", { from: "2026-11-01", to: "2026-11-10" });
  });
});

describe("summarize", () => {
  it("posts what it wrote to the team channel when asked", async () => {
    spy("summarize").mockResolvedValue({ markdown: "# Day", channels: 1, sealed: "enc" });
    const post = spy("postSummary").mockResolvedValue({ channels: 1 });

    expect(await run("summarize", { project: "BP", kind: "standup", post: true })).toEqual({ markdown: "# Day", posted: { channels: 1 } });
    expect(post).toHaveBeenCalledWith("p1", "enc");
  });

  it("says there is no channel, and still hands back the summary", async () => {
    spy("summarize").mockResolvedValue({ markdown: "# Day", channels: 0, sealed: null });
    const post = spy("postSummary");

    await expect(run("summarize", { project: "BP", kind: "project", post: true })).rejects.toThrow(/no team channel[\s\S]*# Day/);
    expect(post).not.toHaveBeenCalled();
  });

  it("tells a channel the instance cannot post to from no channel at all", async () => {
    spy("summarize").mockResolvedValue({ markdown: "# Day", channels: 2, sealed: null });

    await expect(run("summarize", { project: "BP", kind: "project", post: true })).rejects.toThrow(/cannot post summaries \(no ENCRYPTION_KEY\)/);
  });

  it("refuses a sprint summary with no sprint, without spending a call", async () => {
    const write = spy("summarize");
    await expect(run("summarize", { project: "BP", kind: "sprint" })).rejects.toThrow(/names its sprint/);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("ask_pm", () => {
  it("answers with the PM's reply and the actions it took", async () => {
    spy("askPm").mockResolvedValue({ ok: true, message: "Moved BP-2", actions: [{ tool: "change_status" }] });

    expect(await run("ask_pm", { project: "BP", message: "tidy up" })).toEqual({ answer: "Moved BP-2", actions: [{ tool: "change_status" }] });
  });

  it("answers that the PM is still working when the turn outlasts the wait, rather than failing", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const waited = new AbortController();
      setTimeout(() => waited.abort(), 5);
      return waited.signal;
    });
    spy("askPm").mockImplementation(
      (_p: string, _m: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
    );

    expect(await run("ask_pm", { project: "BP", message: "long" })).toMatchObject({ pending: true });
  });

  it("fails the call on a transport error that is not the wait running out", async () => {
    spy("askPm").mockRejectedValue(new Error("Someone is already talking to the PM agent on this project"));

    await expect(run("ask_pm", { project: "BP", message: "hi" })).rejects.toThrow(/already talking/);
  });

  it("fails the call when the turn failed, with the PM's reason", async () => {
    spy("askPm").mockResolvedValue({ ok: false, message: "", error: "Someone is already talking to the PM agent", actions: [] });

    await expect(run("ask_pm", { project: "BP", message: "hi" })).rejects.toThrow(/already talking/);
  });
});

describe("pm_messages", () => {
  it("answers each message's role, text and actions, and nothing else the row carries", async () => {
    const read = spy("pmMessages").mockResolvedValue({
      messages: [
        { role: "user", content: "hi", createdAt: "t1", triggeredBy: { username: "ola" } },
        { role: "assistant", content: "Moved", createdAt: "t2", actions: [{ tool: "change_status", taskKey: "BP-2", summary: "s", at: "x" }], usage: { tokens: 9 } },
      ],
    });

    expect(await run("pm_messages", { project: "BP", limit: 2 })).toEqual([
      { role: "user", at: "t1", content: "hi" },
      { role: "assistant", at: "t2", content: "Moved", actions: [{ tool: "change_status", taskKey: "BP-2", summary: "s" }] },
    ]);
    expect(read).toHaveBeenCalledWith("p1", 2);
  });
});

describe("readPmTurn", () => {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  // The route sends the stored assistant message, an object, as `message` (pm/chat/route.ts)
  it("answers with the stored message's text and actions, and skips heartbeats and streamed deltas", () => {
    const stored = { _id: "m1", role: "assistant", content: "Moved BP-2.", actions: [{ tool: "change_status", taskKey: "BP-2", summary: "to done", at: "x" }] };
    const stream = `: accepted\n\n${frame("action", { tool: "change_status" })}: ping\n\n${frame("delta", { text: "Mo" })}${frame("done", { message: stored, interrupted: false })}`;

    expect(readPmTurn(stream)).toEqual({
      ok: true,
      message: "Moved BP-2.",
      interrupted: false,
      actions: [{ tool: "change_status", taskKey: "BP-2", summary: "to done" }],
    });
  });

  it("reports an error event as a failed turn, with what the PM managed to say", () => {
    expect(readPmTurn(frame("error", { error: "Budget used", message: { content: "Partly done" } }))).toMatchObject({
      ok: false,
      error: "Budget used",
      message: "Partly done",
    });
    expect(readPmTurn(frame("error", { error: "Project not found", message: null }))).toMatchObject({ ok: false, message: "" });
  });

  it("does not take a stream cut off before its end for an answer", () => {
    expect(readPmTurn(frame("action", { tool: "x" }))).toMatchObject({ ok: false, error: "The PM turn ended without an answer" });
  });
});
