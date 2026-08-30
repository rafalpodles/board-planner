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
vi.mock("@/models/pmMessage", () => ({
  PmMessage: {
    create: vi.fn(async () => pmMessage()),
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
  // Stands in for the real guard, which tools.arg-guard.test.ts drives against the real schemas.
  // What is under test here is that the dispatcher consults it at all, and before execute
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
