import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const chatCompletion = vi.fn();
const changeStatusExecute = vi.fn();
const assignTaskExecute = vi.fn();
const addCommentExecute = vi.fn();

const PROJECT = {
  _id: "69a52e3b399b27d3cbb2c5a5",
  key: "BP",
  pm: { enabled: true, model: "test/model" },
};

function pmMessage() {
  const doc = {
    actions: [] as { tool: string; summary: string }[],
    content: "",
    usage: undefined as undefined | Record<string, number | boolean>,
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(() => ({ content: doc.content, actions: doc.actions })),
  };
  return doc;
}

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({
  Project: { findById: vi.fn().mockResolvedValue(PROJECT) },
}));
vi.mock("@/models/user", () => ({
  User: {
    findById: () => ({
      select: () => ({ lean: () => Promise.resolve({ username: "pm", fullName: "PM" }) }),
    }),
  },
}));
// How many rows the replay window returned. At HISTORY_LIMIT the window has stopped growing, which
// is what decides whether the first call of a turn is worth a history cache write at all.
const historyDocsMock = vi.fn(async (): Promise<unknown[]> => []);
const createdMessages: ReturnType<typeof pmMessage>[] = [];
vi.mock("@/models/pmMessage", () => ({
  PmMessage: {
    create: vi.fn(async () => {
      const doc = pmMessage();
      createdMessages.push(doc);
      return doc;
    }),
    find: () => ({
      sort: () => ({ limit: () => ({ populate: () => ({ lean: () => historyDocsMock() }) }) }),
    }),
  },
}));
vi.mock("./pm-user", () => ({
  getPmUser: vi.fn().mockResolvedValue({ _id: "pm-user-id" }),
  PM_USERNAME: "pm",
}));
vi.mock("./openrouter", () => ({ chatCompletion }));
vi.mock("./availability", () => ({
  isPmRunnable: () => true,
  pmDisabledReason: () => "",
  resolvePmModel: async () => "test/model",
}));
// A function, not a constant: BP-321's withholding is about which MCP tools a turn is offered, and
// a mock that always answers "none" can only ever prove the empty case.
const discoverMcpToolsMock = vi.fn(async () => ({
  tools: new Map<string, unknown>(),
  serverNames: [] as string[],
}));
vi.mock("./mcp-tools", () => ({
  discoverMcpTools: () => discoverMcpToolsMock(),
  callMcpTool: vi.fn(),
  MAX_MCP_CALLS_PER_TURN: 5,
}));
// A function, not a constant: what the cache breakpoint marks is the END of the replayed history,
// so a mock that can only answer "no history" cannot tell the right boundary from the wrong one
const replayHistoryMock = vi.fn(async () => [] as { role: string; content: string }[]);
vi.mock("./history", () => ({
  replayHistory: () => replayHistoryMock(),
  stripSpoofedLabels: (s: string) => s,
  HISTORY_AUTHOR_PREFIX: "",
}));
// A function, not a constant: a turn carrying only a picture puts an extra system message in
// front of the user content, and that nudge is one of the things the cache boundary must exclude
const buildUserContentMock = vi.fn(async (text: string): Promise<unknown> => text);
vi.mock("./attachments", () => ({ buildUserContent: (text: string) => buildUserContentMock(text) }));
vi.mock("@/lib/columns", () => ({
  getProjectColumns: () => [{ id: "todo", role: "approved" }],
  defaultStatusFor: () => "todo",
}));
vi.mock("./tools", () => ({
  pmToolDefinitions: () => [
    { name: "change_status", description: "", parameters: {} },
    { name: "assign_task", description: "", parameters: {} },
    { name: "add_comment", description: "", parameters: {} },
  ],
  PM_TOOLS: {
    change_status: { write: true, execute: changeStatusExecute },
    assign_task: { write: true, execute: assignTaskExecute },
    add_comment: { write: true, execute: addCommentExecute },
  },
  // Stands in for the real guard, which tools.arg-guard.test.ts drives against the real schemas.
  // What is under test here is that the dispatcher consults it at all, and before execute
  refuseUndeclaredArgs: (_tool: unknown, args: Record<string, unknown>) =>
    "stray" in args ? 'Not a parameter of this tool: "stray".' : null,
}));

const { runPmTurn } = await import("./agent");
// Not mocked: what the sticky key is computed FROM is the claim under test, and the function that
// computes it is pinned separately in prompt-cache.test.ts
const { pmSessionId } = await import("./prompt-cache");
const { NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS, BOARD_REVIEW_DISALLOWED_TOOLS } = await import("./autonomy");

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    type: "tools" as const,
    assistantMessage: { role: "assistant" as const, content: "", tool_calls: [] },
    calls: [{ id: `call-${name}`, name, args }],
  };
}

function turn(disallowedTools: string[], autonomous = false) {
  return runPmTurn({
    projectId: PROJECT._id,
    userMessage: "trigger",
    triggeredByUserId: "pm-user-id",
    trigger: { type: "needs_human_review", taskKey: "BP-1" },
    disallowedTools,
    autonomous,
  });
}

function toolReplies() {
  return chatCompletion.mock.calls
    .flatMap((call) => call[0].messages as { role: string; content: string }[])
    .filter((m) => m.role === "tool")
    .map((m) => m.content);
}

beforeEach(() => {
  vi.clearAllMocks();
  addCommentExecute.mockResolvedValue({ result: { ok: true } });
});

// BP-301: board text reaches this turn verbatim, so withholding has to survive a model
// that calls the tool anyway — the definition being absent is not the boundary.
describe("runPmTurn withholding", () => {
  it("refuses a withheld tool the model calls regardless, without executing it", async () => {
    chatCompletion
      .mockResolvedValueOnce(toolCall("assign_task", { taskKey: "BP-1", assignee: "claude" }))
      .mockResolvedValueOnce(toolCall("change_status", { taskKey: "BP-1", status: "todo" }))
      .mockResolvedValueOnce({ type: "text", content: "done" });

    const result = await turn(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS);

    expect(result.ok).toBe(true);
    expect(assignTaskExecute).not.toHaveBeenCalled();
    expect(changeStatusExecute).not.toHaveBeenCalled();
    expect(toolReplies().join("\n")).toContain("is not available in this turn");
  });

  it("hides a withheld tool from the definitions it offers the model", async () => {
    chatCompletion.mockResolvedValue({ type: "text", content: "done" });

    await turn(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS);

    const offered = chatCompletion.mock.calls[0][0].tools.map((t: { name: string }) => t.name);
    expect(offered).toEqual(["add_comment"]);
  });

  it("still runs the tools the turn is meant to have", async () => {
    chatCompletion
      .mockResolvedValueOnce(toolCall("add_comment", { taskKey: "BP-1", body: "answer" }))
      .mockResolvedValueOnce({ type: "text", content: "done" });

    await turn(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS);

    expect(addCommentExecute).toHaveBeenCalled();
  });
});

// Step 4 of the chain in BP-301 needs the task assigned to the machine's owner by that owner, an
// agent named, and a status in an approved column; any one missing stops claimNextTask from matching.
describe("autonomous turns cannot hand work to a machine", () => {
  it("withholds assign_task and change_status from the needs_human_review trigger", () => {
    expect(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS).toContain("assign_task");
    expect(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS).toContain("change_status");
  });

  it("withholds assign_task from the scheduled board review too", () => {
    expect(BOARD_REVIEW_DISALLOWED_TOOLS).toContain("assign_task");
    expect(BOARD_REVIEW_DISALLOWED_TOOLS).toContain("change_status");
  });
});

/**
 * BP-500. The tools whitelist what they apply and dropped the rest in silence — the shape BP-497
 * fixed on the MCP servers, on the same tool name, reachable from an autonomous turn.
 */
describe("a tool call naming a parameter the tool does not declare", () => {
  it("is refused without the tool running", async () => {
    chatCompletion
      .mockResolvedValueOnce(toolCall("change_status", { taskKey: "BP-1", stray: "done" }))
      .mockResolvedValueOnce({ type: "text", assistantMessage: { role: "assistant", content: "ok" }, content: "ok" });

    await turn([]);

    expect(changeStatusExecute).not.toHaveBeenCalled();
    expect(toolReplies().join("\n")).toContain("stray");
  });

  // The control: the same path still runs a call whose parameters are all declared
  it("still runs a call that names only what the tool declares", async () => {
    chatCompletion
      .mockResolvedValueOnce(toolCall("change_status", { taskKey: "BP-1" }))
      .mockResolvedValueOnce({ type: "text", assistantMessage: { role: "assistant", content: "ok" }, content: "ok" });

    await turn([]);

    expect(changeStatusExecute).toHaveBeenCalled();
  });
});

/**
 * BP-321, finding 3. `disallowedTools` is a list of exact names, MCP tools are exposed as
 * `mcp_<server>_<tool>`, and both autonomy lists name only the four built-in PM tools — so no MCP
 * tool was ever withheld from an unattended turn. On a project with a write-enabled MCP server,
 * an injected autonomous turn kept full write access to it. That is the arm that reaches furthest
 * now that a PM assignment can put work on a machine (BP-419).
 */
describe("an unattended turn and a project's MCP server", () => {
  const mcpTool = (exposedName: string, write: boolean): [string, unknown] => [
    exposedName,
    {
      exposedName,
      serverName: "acme",
      toolName: exposedName,
      write,
      definition: { name: exposedName, description: "", parameters: { type: "object", properties: {} } },
      client: {},
    },
  ];

  beforeEach(() => {
    discoverMcpToolsMock.mockResolvedValue({
      tools: new Map([
        mcpTool("mcp_acme_create_ticket", true),
        mcpTool("mcp_acme_list_tickets", false),
      ]) as never,
      serverNames: ["acme"],
    });
  });

  const offered = () =>
    chatCompletion.mock.calls[0][0].tools.map((t: { name: string }) => t.name) as string[];

  it("is offered no MCP tool that writes", async () => {
    chatCompletion.mockResolvedValue({ type: "text", content: "done" });

    await turn(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS, true);

    expect(offered()).not.toContain("mcp_acme_create_ticket");
  });

  // The control, in the same run: withholding writes must not be "withholding everything", or the
  // board review loses the reads it exists to do
  it("keeps the read-only ones", async () => {
    chatCompletion.mockResolvedValue({ type: "text", content: "done" });

    await turn(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS, true);

    expect(offered()).toContain("mcp_acme_list_tickets");
  });

  // The other control: a turn somebody is driving is unchanged
  it("leaves an attended turn with both", async () => {
    chatCompletion.mockResolvedValue({ type: "text", content: "done" });

    await turn([], false);

    expect(offered()).toEqual(expect.arrayContaining(["mcp_acme_create_ticket", "mcp_acme_list_tickets"]));
  });

  it("refuses the withheld MCP tool at dispatch, not only in the list it offers", async () => {
    chatCompletion
      .mockResolvedValueOnce(toolCall("mcp_acme_create_ticket", {}))
      .mockResolvedValueOnce({ type: "text", content: "done" });

    const result = await turn(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS, true);

    expect(result.ok).toBe(true);
    expect(toolReplies().join("\n")).toContain("is not available in this turn");
  });
});

/**
 * BP-284. `dailyTurnCap` counts turns, and this loop makes up to MAX_STEPS round-trips per turn, so
 * the cap permitted a fifteen-fold range of spend. The provider reports usage on every response and
 * the client discarded it; the turn now records what it cost, on every exit including the ones that
 * fail — a turn that burned nine calls and then met a provider error cost nine calls.
 */
describe("what a turn records about its own cost", () => {
  const withUsage = (result: object, tokens: number, cached = 0, written = 0) => ({
    ...result,
    usage: {
      promptTokens: tokens,
      completionTokens: tokens,
      totalTokens: tokens * 2,
      cachedPromptTokens: cached,
      cacheWriteTokens: written,
    },
  });

  const lastMessage = () => createdMessages[createdMessages.length - 1];

  beforeEach(() => {
    createdMessages.length = 0;
  });

  it("sums the round-trips it made, not the one turn it is", async () => {
    chatCompletion
      .mockResolvedValueOnce(withUsage(toolCall("add_comment", { taskKey: "BP-1", body: "x" }), 100))
      .mockResolvedValueOnce(withUsage({ type: "text", content: "done" }, 50));

    await turn([]);

    expect(lastMessage().usage).toMatchObject({
      calls: 2,
      promptTokens: 150,
      completionTokens: 150,
      totalTokens: 300,
      hitStepLimit: false,
    });
  });

  // The control: one call is one call, so the number is not inflated by the loop itself
  it("records a single round-trip as one", async () => {
    chatCompletion.mockResolvedValue(withUsage({ type: "text", content: "done" }, 10));

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ calls: 1, totalTokens: 20 });
  });

  it("counts a call the provider then failed, because it was still made", async () => {
    chatCompletion
      .mockResolvedValueOnce(withUsage(toolCall("add_comment", { taskKey: "BP-1", body: "x" }), 100))
      .mockResolvedValueOnce({ type: "error", error: "provider exploded" });

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ calls: 2 });
  });

  /**
   * The most expensive shape a turn takes, and the one the operator most wants to hear about: it
   * spent every step and stopped because it ran out, not because it was finished. Nothing asserted
   * this arm, so the flag, the `$cond` that counts it and the sentence on the settings screen all
   * rested on one untested line.
   */
  it("says when it ran out of steps rather than finishing", async () => {
    chatCompletion.mockResolvedValue(
      withUsage(toolCall("add_comment", { taskKey: "BP-1", body: "again" }), 10)
    );

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ hitStepLimit: true, calls: 15 });
  });

  // The control: a turn that finished says it did, so the flag is not simply always true
  it("does not claim it ran out when it answered", async () => {
    chatCompletion.mockResolvedValue(withUsage({ type: "text", content: "done" }, 10));

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ hitStepLimit: false });
  });

  // A provider that reports no usage must read as "unknown", never as free
  it("still counts the calls when the provider reports no usage at all", async () => {
    chatCompletion.mockResolvedValue({ type: "text", content: "done" });

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ calls: 1, totalTokens: 0 });
  });

  /**
   * BP-568. The saving lives in the calls after the first: the first pays a cache write for the
   * prefix and the rest read it back. Recorded beside the tokens rather than inside them, so the
   * day's total still means what a budget is set from.
   */
  it("sums what its round-trips read from the cache, without touching the total", async () => {
    chatCompletion
      .mockResolvedValueOnce(withUsage(toolCall("add_comment", { taskKey: "BP-1", body: "x" }), 100, 0, 90))
      .mockResolvedValueOnce(withUsage({ type: "text", content: "done" }, 100, 90, 0));

    await turn([]);

    expect(lastMessage().usage).toMatchObject({
      calls: 2,
      totalTokens: 400,
      cachedPromptTokens: 90,
      cacheWriteTokens: 90,
    });
  });

  // The control: a provider that caches nothing records zero, not the prompt count
  it("records nothing cached when nothing was", async () => {
    chatCompletion.mockResolvedValue(withUsage({ type: "text", content: "done" }, 100));

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ cachedPromptTokens: 0, cacheWriteTokens: 0 });
  });
});

/**
 * BP-568. What the loop tells the client to cache. The prefix is named by a message count, and a
 * count that drifted with the conversation would mark a boundary that moves on every call — every
 * one of them a cache write, which is worse than not caching at all.
 */
describe("the prefix a turn asks to be cached", () => {
  /**
   * Snapshotted at call time, not read back off the mock afterwards. The loop pushes into one
   * `messages` array and hands the same reference to every call, so `mock.calls[0]` and
   * `mock.calls[1]` are the same object — comparing them proved only that an array equals itself,
   * and the comparison passed with the prefix bookkeeping deleted.
   */
  const sent: {
    messages: { role: string; content?: unknown }[];
    cachePrefixLength: number;
    sessionId: string;
  }[] = [];

  function answering(...results: object[]) {
    let i = 0;
    chatCompletion.mockImplementation(async (opts: Record<string, unknown>) => {
      sent.push(
        JSON.parse(
          JSON.stringify({
            messages: opts.messages,
            cachePrefixLength: opts.cachePrefixLength,
            sessionId: opts.sessionId,
          })
        )
      );
      return results[Math.min(i++, results.length - 1)];
    });
  }

  const HISTORY = [
    { role: "user", content: "an older question" },
    { role: "assistant", content: "an older answer" },
  ];

  beforeEach(() => {
    sent.length = 0;
    replayHistoryMock.mockResolvedValue(HISTORY);
  });

  // Both implementations outlive `vi.clearAllMocks`, which clears calls and not behaviour — a
  // later test in this file would otherwise inherit a stub answering "done" forever, and a history
  // it never asked for
  afterEach(() => {
    chatCompletion.mockReset();
    replayHistoryMock.mockImplementation(async () => []);
    buildUserContentMock.mockImplementation(async (text: string) => text);
    historyDocsMock.mockImplementation(async () => []);
  });

  const twoCalls = () =>
    answering(toolCall("add_comment", { taskKey: "BP-1", body: "x" }), { type: "text", content: "done" });

  it("is the same messages, byte for byte, on the second call as on the first", async () => {
    twoCalls();

    await turn([]);

    const prefixOf = (call: number) =>
      JSON.stringify(sent[call].messages.slice(0, sent[call].cachePrefixLength));

    expect(sent).toHaveLength(2);
    expect(sent[1].cachePrefixLength).toBe(sent[0].cachePrefixLength);
    expect(prefixOf(1)).toBe(prefixOf(0));
    // The control: the second request really had grown past the mark, so the two were not equal
    // for the trivial reason
    expect(sent[1].messages.length).toBeGreaterThan(sent[0].messages.length);
  });

  /**
   * The boundary, and the reason it is where it is. A cache write costs more than the cold prompt
   * it replaces, so a mark is only worth making where something later reads it back. The system
   * prompt and the replayed history are read by every later call of this turn AND by every turn
   * after it; this turn's own user message is read by neither once the turn answers in one call,
   * which is what an ordinary conversational turn does (BP-568 review).
   */
  it("ends at the replayed history, not at this turn's own question", async () => {
    twoCalls();

    await turn([]);

    const marked = sent[1].messages.slice(0, sent[1].cachePrefixLength);

    expect(marked.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(marked[marked.length - 1].content).toBe("an older answer");
    // This turn's question, and everything the loop appended after it, sit past the mark
    expect(marked.some((m) => m.content === "trigger")).toBe(false);
    expect(marked.some((m) => m.role === "tool")).toBe(false);
    // The controls: both really were in that request, just not inside the marked prefix
    expect(sent[1].messages.some((m) => m.content === "trigger")).toBe(true);
    expect(sent[1].messages.some((m) => m.role === "tool")).toBe(true);
  });

  /**
   * A turn carrying a picture and no words puts a second system message — the "describe what you
   * see and change nothing" nudge — between the history and the user content. Both it and the
   * picture are this turn's, so both belong past the mark; a picture written into a cache that
   * nothing reads back is the most expensive mistake available here.
   *
   * Without this case the boundary is untestable in the direction that matters: with no image in
   * play, `1 + replayed.length` and `messages.length - 1` are the same number, so a whole suite
   * of turns agrees with an off-by-one.
   */
  it("leaves the image nudge, and the picture, outside the marked prefix", async () => {
    buildUserContentMock.mockResolvedValue([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
    answering({ type: "text", content: "a screenshot of a board" });

    await runPmTurn({
      projectId: PROJECT._id,
      userMessage: "",
      triggeredByUserId: "pm-user-id",
      trigger: { type: "chat" },
    });

    const request = sent[0];
    const marked = request.messages.slice(0, request.cachePrefixLength);

    expect(marked.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    // Both system messages went out; only the standing rules are inside the mark
    expect(request.messages.filter((m) => m.role === "system")).toHaveLength(2);
    expect(marked.filter((m) => m.role === "system")).toHaveLength(1);
    // The control: the picture really was in the request, just past the boundary
    expect(JSON.stringify(request.messages)).toContain("image_url");
    expect(JSON.stringify(marked)).not.toContain("image_url");
  });

  /**
   * The mark goes on from the first call, whatever the thread looks like, and that is a bet rather
   * than a certainty: a turn that answers in one call pays about 25% more for its prefix than it
   * would unmarked, while a two-call turn already saves ~30% and a six-call turn saves most of
   * five prefixes.
   *
   * An earlier version withheld the mark once the replay window had filled, reasoning that a
   * single-call turn's write would be read by the NEXT turn instead. That is wrong for a reason no
   * message count can see: an ephemeral entry lives five minutes on Anthropic and a conversation
   * is slower than that. This test exists to stop the idea coming back — a filled window must look
   * exactly like a growing one here (BP-568 review).
   */
  it("marks from the first call whether or not the replay window has filled", async () => {
    historyDocsMock.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({ content: `old ${i}` })));
    twoCalls();

    await turn([]);

    expect(sent.map((r) => r.cachePrefixLength)).toEqual([1 + HISTORY.length, 1 + HISTORY.length]);
  });

  /**
   * The key must be this board and this reader, in that order. A shape assertion alone leaves both
   * mistakes green: a constant would be one conversation for the whole instance, sending every
   * reader to an endpoint holding somebody else's prefix, and swapping the pair would be a
   * different key for the same thread every time a different board is read (BP-568 review).
   */
  it("names one conversation for every call of the turn, keyed by board and reader", async () => {
    twoCalls();

    await turn([]);

    expect(sent[0].sessionId).toBe(pmSessionId(PROJECT._id, "pm-user-id"));
    expect(sent[1].sessionId).toBe(sent[0].sessionId);
  });
});
