import { describe, it, expect, vi, beforeEach } from "vitest";

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
const createdMessages: ReturnType<typeof pmMessage>[] = [];
vi.mock("@/models/pmMessage", () => ({
  PmMessage: {
    create: vi.fn(async () => {
      const doc = pmMessage();
      createdMessages.push(doc);
      return doc;
    }),
    find: () => ({
      sort: () => ({ limit: () => ({ populate: () => ({ lean: () => Promise.resolve([]) }) }) }),
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
const discoverMcpToolsMock = vi.fn(async () => ({
  tools: new Map<string, unknown>(),
  serverNames: [] as string[],
}));
vi.mock("./mcp-tools", () => ({
  discoverMcpTools: () => discoverMcpToolsMock(),
  callMcpTool: vi.fn(),
  MAX_MCP_CALLS_PER_TURN: 5,
}));
vi.mock("./history", () => ({
  replayHistory: async () => [],
  stripSpoofedLabels: (s: string) => s,
  HISTORY_AUTHOR_PREFIX: "",
}));
vi.mock("./attachments", () => ({ buildUserContent: async (s: string) => s }));
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
  refuseUndeclaredArgs: (_tool: unknown, args: Record<string, unknown>) =>
    "stray" in args ? 'Not a parameter of this tool: "stray".' : null,
}));

const { runPmTurn } = await import("./agent");
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

describe("a tool call naming a parameter the tool does not declare", () => {
  it("is refused without the tool running", async () => {
    chatCompletion
      .mockResolvedValueOnce(toolCall("change_status", { taskKey: "BP-1", stray: "done" }))
      .mockResolvedValueOnce({ type: "text", assistantMessage: { role: "assistant", content: "ok" }, content: "ok" });

    await turn([]);

    expect(changeStatusExecute).not.toHaveBeenCalled();
    expect(toolReplies().join("\n")).toContain("stray");
  });

  it("still runs a call that names only what the tool declares", async () => {
    chatCompletion
      .mockResolvedValueOnce(toolCall("change_status", { taskKey: "BP-1" }))
      .mockResolvedValueOnce({ type: "text", assistantMessage: { role: "assistant", content: "ok" }, content: "ok" });

    await turn([]);

    expect(changeStatusExecute).toHaveBeenCalled();
  });
});

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

  it("keeps the read-only ones", async () => {
    chatCompletion.mockResolvedValue({ type: "text", content: "done" });

    await turn(NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS, true);

    expect(offered()).toContain("mcp_acme_list_tickets");
  });

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

describe("what a turn records about its own cost", () => {
  const withUsage = (result: object, tokens: number) => ({
    ...result,
    usage: { promptTokens: tokens, completionTokens: tokens, totalTokens: tokens * 2 },
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

  it("says when it ran out of steps rather than finishing", async () => {
    chatCompletion.mockResolvedValue(
      withUsage(toolCall("add_comment", { taskKey: "BP-1", body: "again" }), 10)
    );

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ hitStepLimit: true, calls: 15 });
  });

  it("does not claim it ran out when it answered", async () => {
    chatCompletion.mockResolvedValue(withUsage({ type: "text", content: "done" }, 10));

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ hitStepLimit: false });
  });

  it("still counts the calls when the provider reports no usage at all", async () => {
    chatCompletion.mockResolvedValue({ type: "text", content: "done" });

    await turn([]);

    expect(lastMessage().usage).toMatchObject({ calls: 1, totalTokens: 0 });
  });
});
