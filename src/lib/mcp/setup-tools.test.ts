import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPlannerTools } from "./tools";
import { PlannerClient } from "./planner-client";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;

function tools() {
  const found = new Map<string, Handler>();
  registerPlannerTools({ registerTool: (name: string, _config: unknown, handler: Handler) => found.set(name, handler) } as unknown as McpServer);
  return found;
}

const extra = { authInfo: { token: "cp_x", extra: { baseUrl: "https://board.example.com" } } };
const run = async (name: string, args: Record<string, unknown>) => JSON.parse((await tools().get(name)!(args, extra)).content[0].text);
const spy = <K extends keyof PlannerClient>(method: K) => vi.spyOn(PlannerClient.prototype, method as never) as ReturnType<typeof vi.fn>;

const COLUMNS = [
  { id: "todo", label: "To do", role: "approved", color: "#111111", order: 0 },
  { id: "doing", label: "Doing", role: "active", color: "#222222", order: 1 },
  { id: "done", label: "Done", role: "done", color: "#333333", order: 2 },
];
const FIELD = {
  _id: "64b000000000000000000001",
  name: "Size",
  fieldType: "dropdown",
  options: [
    { id: "s", value: "Small", color: "#111111", order: 0 },
    { id: "l", value: "Large", color: "#222222", order: 1 },
  ],
};

function board({ owner = true, ...rest }: { owner?: boolean } & Record<string, unknown> = {}) {
  spy("getProjectByKey").mockResolvedValue({ _id: "p1", key: "BP", canAdmin: owner } as never);
  spy("getProject").mockResolvedValue({ _id: "p1", key: "BP", canAdmin: owner, columns: COLUMNS, customFields: [FIELD], ...rest } as never);
}

beforeEach(() => vi.restoreAllMocks());

describe("create_project", () => {
  it("sends what was named, the PM switch as the route takes it, and answers the board's link", async () => {
    const create = spy("createProject").mockResolvedValue({ _id: "p9", key: "WEB", name: "Web", columns: [] } as never);

    const answer = await run("create_project", { name: "Web", key: "web", pmEnabled: true });

    expect(create).toHaveBeenCalledWith({ name: "Web", key: "web", pm: { enabled: true } });
    expect(answer.url).toBe("https://board.example.com/projects/WEB");
    expect(answer.columns.length).toBeGreaterThan(0);
  });
});

describe("update_project", () => {
  it("refuses somebody who does not own the board before writing anything", async () => {
    board({ owner: false });
    const update = spy("updateProject");

    await expect(run("update_project", { project: "BP", name: "X" })).rejects.toThrow(/Only a project owner can change the board's settings/);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a call that names nothing", async () => {
    board();
    await expect(run("update_project", { project: "BP" })).rejects.toThrow(/update_project named nothing to change/);
  });

  it("resolves the estimate field by name and sends only what was named", async () => {
    board();
    const update = spy("updateProject").mockResolvedValue({});

    await run("update_project", { project: "BP", description: "d", estimateField: "size" });

    expect(update).toHaveBeenCalledWith("p1", { description: "d", estimateFieldId: FIELD._id });
  });

  it("merges a schedule change into the stored one, which the route would otherwise reset to defaults", async () => {
    board({ pm: { enabled: true, autonomy: { dailyReview: true, reviewHour: 7, reviewIntervalHours: 24, timezone: "Europe/Warsaw" } } });
    spy("getMe").mockResolvedValue({ username: "o", role: "member" });
    const update = spy("updateProject").mockResolvedValue({});

    await run("update_project", { project: "BP", pm: { reviewHour: 9 } });

    expect(update).toHaveBeenCalledWith("p1", {
      pm: { autonomy: { dailyReview: true, reviewHour: 9, reviewIntervalHours: 24, timezone: "Europe/Warsaw" } },
    });
  });

  it("repeats the stored PM switch for an admin, whose save the route validates whole", async () => {
    board({ pm: { enabled: true, autonomy: {} } });
    spy("getMe").mockResolvedValue({ username: "a", role: "admin" });
    const update = spy("updateProject").mockResolvedValue({});

    await run("update_project", { project: "BP", pm: { contextNotes: "n" } });

    expect(update).toHaveBeenCalledWith("p1", { pm: { enabled: true, contextNotes: "n" } });
  });

  it("sets the default agent by name, and clears it with an empty string", async () => {
    board();
    spy("listAgents").mockResolvedValue([{ _id: "a1", name: "Ship", scope: "project", projectId: "p1" }]);
    const setDefault = spy("setDefaultAgent").mockResolvedValue({});
    const update = spy("updateProject");

    await run("update_project", { project: "BP", defaultAgent: "ship" });
    await run("update_project", { project: "BP", defaultAgent: "" });

    expect(setDefault.mock.calls).toEqual([["p1", "a1"], ["p1", ""]]);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("set_member and remove_member", () => {
  const MEMBERS = [
    { _id: "u1", username: "ola", relation: "owner" },
    { _id: "u2", username: "root", relation: null, instanceAdmin: true },
  ];

  it("changes the relation of somebody already on the board", async () => {
    board();
    spy("listProjectMembers").mockResolvedValue(MEMBERS);
    const set = spy("setMember").mockResolvedValue({});

    expect(await run("set_member", { project: "BP", username: "OLA", relation: "member" })).toEqual({
      username: "ola",
      relation: "member",
      before: "owner",
    });
    expect(set).toHaveBeenCalledWith("p1", "u1", "member");
  });

  it("adds somebody not yet on the board, matched exactly among the candidates", async () => {
    board();
    spy("listProjectMembers").mockResolvedValue(MEMBERS);
    spy("findMemberCandidates").mockResolvedValue([
      { _id: "u7", username: "janek" },
      { _id: "u8", username: "jan" },
    ]);
    const set = spy("setMember").mockResolvedValue({});

    await run("set_member", { project: "BP", username: "jan", relation: "member" });

    expect(set).toHaveBeenCalledWith("p1", "u8", "member");
  });

  it("points at the app for somebody with no account, and writes nothing", async () => {
    board();
    spy("listProjectMembers").mockResolvedValue(MEMBERS);
    spy("findMemberCandidates").mockResolvedValue([{ _id: "u7", username: "janek" }]);
    const set = spy("setMember");

    await expect(run("set_member", { project: "BP", username: "jan", relation: "member" })).rejects.toThrow(/Settings → Members/);
    expect(set).not.toHaveBeenCalled();
  });

  it("removes only a grant the person holds, not an instance admin's standing", async () => {
    board();
    spy("listProjectMembers").mockResolvedValue(MEMBERS);
    const remove = spy("removeMember").mockResolvedValue({});

    await expect(run("remove_member", { project: "BP", username: "root" })).rejects.toThrow(/no access of their own/);
    await run("remove_member", { project: "BP", username: "ola" });

    expect(remove.mock.calls).toEqual([["p1", "u1"]]);
  });
});

describe("list_members with relations", () => {
  it("is the owner's, and says who holds what", async () => {
    board();
    spy("listProjectMembers").mockResolvedValue([{ _id: "u1", username: "ola", fullName: "Ola", relation: "owner", source: "idp" }]);

    expect(await run("list_members", { project: "BP", relations: true })).toEqual([
      { username: "ola", fullName: "Ola", relation: "owner", fromGroup: true },
    ]);
  });

  it("is refused to a member", async () => {
    board({ owner: false });
    await expect(run("list_members", { project: "BP", relations: true })).rejects.toThrow(/Only a project owner/);
  });
});

describe("agents", () => {
  const BLOCKS = [
    { _id: "b1", key: "implement", name: "Implement", kind: "step" },
    { _id: "b2", key: "diff-size", name: "Size", kind: "gate" },
  ];

  it("creates a board's agent from blocks named by name or key", async () => {
    board();
    spy("listAgentBlocks").mockResolvedValue(BLOCKS);
    const create = spy("createAgent").mockResolvedValue({ name: "Ship", scope: "project", composition: {} });

    await run("create_agent", { name: "Ship", project: "BP", composition: { implementation: ["implement"], verification: [{ block: "Size", params: { maxLines: "100" } }] } });

    expect(create).toHaveBeenCalledWith({
      name: "Ship",
      projectId: "p1",
      composition: {
        analysis: [],
        implementation: [{ key: "implement" }],
        verification: [{ key: "diff-size", params: { maxLines: "100" } }],
        delivery: [],
      },
    });
  });

  it("creates a personal agent when no project is named", async () => {
    spy("listAgentBlocks").mockResolvedValue(BLOCKS);
    const create = spy("createAgent").mockResolvedValue({ name: "Mine", scope: "user" });

    await run("create_agent", { name: "Mine", composition: {} });

    expect(create.mock.calls[0][0]).not.toHaveProperty("projectId");
  });

  it("updates an agent found by name and sends only what was named", async () => {
    spy("listAgents").mockResolvedValue([{ _id: "a1", name: "Ship", scope: "global", projectId: null }]);
    const update = spy("updateAgent").mockResolvedValue({ name: "Ship 2", scope: "global" });

    await run("update_agent", { agent: "ship", name: "Ship 2" });

    expect(update).toHaveBeenCalledWith("a1", { name: "Ship 2" });
  });

  it("refuses an update that names nothing, before reading anything", async () => {
    const list = spy("listAgents");
    await expect(run("update_agent", { agent: "Ship" })).rejects.toThrow(/update_agent named nothing to change/);
    expect(list).not.toHaveBeenCalled();
  });

  it("edits and deletes a block by key or name", async () => {
    spy("listAgentBlocks").mockResolvedValue(BLOCKS);
    const update = spy("updateAgentBlock").mockResolvedValue({ ...BLOCKS[0], prompt: "p" });
    const remove = spy("deleteAgentBlock").mockResolvedValue({});

    await run("update_agent_block", { block: "Implement", prompt: "p" });
    expect(await run("delete_agent_block", { block: "diff-size" })).toEqual({ deleted: "diff-size" });

    expect(update).toHaveBeenCalledWith("b1", { prompt: "p" });
    expect(remove).toHaveBeenCalledWith("b2");
  });
});

describe("column tools", () => {
  it("send the whole board with only the named change, read fresh rather than from the board list", async () => {
    board();
    const replace = spy("replaceColumns").mockResolvedValue(COLUMNS);

    await run("update_column", { project: "BP", column: "Doing", triggersPmReview: true });
    await run("remove_column", { project: "BP", column: "todo" });
    await run("reorder_columns", { project: "BP", columns: ["done", "doing", "todo"] });

    expect(replace.mock.calls[0][1]).toEqual(COLUMNS.map((c) => (c.id === "doing" ? { ...c, triggersPmReview: true } : c)));
    expect(replace.mock.calls[1][1].map((c: { id: string }) => c.id)).toEqual(["doing", "done"]);
    expect(replace.mock.calls[2][1].map((c: { id: string; order: number }) => [c.id, c.order])).toEqual([
      ["done", 0],
      ["doing", 1],
      ["todo", 2],
    ]);
  });

  it("are refused to a member without a request", async () => {
    board({ owner: false });
    const replace = spy("replaceColumns");
    await expect(run("remove_column", { project: "BP", column: "todo" })).rejects.toThrow(/Only a project owner/);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("field tools", () => {
  it("delete a field only when confirmName repeats its name", async () => {
    board();
    const remove = spy("deleteCustomField").mockResolvedValue([]);

    await expect(run("delete_custom_field", { project: "BP", field: "size", confirmName: "Sizes" })).rejects.toThrow(/Not deleted/);
    expect(remove).not.toHaveBeenCalled();

    await run("delete_custom_field", { project: "BP", field: FIELD._id, confirmName: "size" });
    expect(remove).toHaveBeenCalledWith("p1", FIELD._id);
  });

  it("rename an option keeping its id, so tasks holding it keep it", async () => {
    board();
    const patch = spy("updateCustomField").mockResolvedValue([FIELD]);

    await run("update_field_option", { project: "BP", field: "Size", option: "Small", value: "Tiny" });

    expect(patch).toHaveBeenCalledWith("p1", FIELD._id, {
      options: [
        { id: "s", value: "Tiny", color: "#111111" },
        { id: "l", value: "Large", color: "#222222" },
      ],
    });
  });

  it("send only the named flags of a field", async () => {
    board();
    const patch = spy("updateCustomField").mockResolvedValue([FIELD]);

    await run("update_custom_field", { project: "BP", field: "Size", archived: true });

    expect(patch).toHaveBeenCalledWith("p1", FIELD._id, { archived: true });
  });
});

describe("save_template", () => {
  const TEMPLATES = [{ _id: "t1", name: "Bug", title: "", description: "", category: "bug", acceptanceCriteria: "" }];

  it("changes the template with that name, renaming it when asked", async () => {
    board({ taskTemplates: TEMPLATES });
    const update = spy("updateTemplate").mockResolvedValue([{ ...TEMPLATES[0], name: "Defect" }]);

    const answer = await run("save_template", { project: "BP", name: "bug", rename: "Defect", title: "T" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { title: "T", name: "Defect" });
    expect(answer).toMatchObject({ created: false, template: { name: "Defect" } });
  });

  it("creates one under a new name, and refuses to rename one that does not exist", async () => {
    board({ taskTemplates: TEMPLATES });
    const add = spy("addTemplate").mockResolvedValue([...TEMPLATES, { ...TEMPLATES[0], _id: "t2", name: "Story" }]);

    expect(await run("save_template", { project: "BP", name: "Story" })).toMatchObject({ created: true });
    expect(add).toHaveBeenCalledWith("p1", { name: "Story" });

    await expect(run("save_template", { project: "BP", name: "Epic", rename: "X" })).rejects.toThrow(/No template "Epic" to rename/);
  });
});
