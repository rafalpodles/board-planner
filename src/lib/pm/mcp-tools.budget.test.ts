import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCP_TOOL_BUDGET } from "./tool-budget";

const McpClientMock = vi.fn();

vi.mock("@/models/project", () => ({ Project: { updateOne: vi.fn() } }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("./mcp-oauth", () => ({ refreshTokens: vi.fn() }));
vi.mock("./config", () => ({ resolveMcpAuthToken: vi.fn(async () => "token") }));
vi.mock("./mcp-client", () => ({ McpClient: McpClientMock }));

const { discoverMcpTools } = await import("./mcp-tools");

const readTools = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `list_${prefix}_thing_${i}`, description: "d" }));

const writeTools = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `create_${prefix}_thing_${i}`, description: "d" }));

const server = (name: string) =>
  ({ name, url: `https://${name}.example/mcp`, authType: "bearer", enabled: true, allowWrites: false, toolAllowlist: [] }) as never;

function serveCounts(counts: Record<string, number>) {
  McpClientMock.mockImplementation((url: string) => {
    const name = new URL(url).hostname.split(".")[0];
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue(readTools(name, counts[name] ?? 0)),
    };
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("discoverMcpTools warns when the servers flood the turn", () => {
  it("warns once, naming the count, the budget and the servers", async () => {
    serveCounts({ notion: 42, github: 44 });

    const runtime = await discoverMcpTools("p1", [server("notion"), server("github")]);

    expect(runtime.tools.size).toBe(86);
    const warnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("MCP tools"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("86");
    expect(warnings[0]).toContain(String(MCP_TOOL_BUDGET));
    expect(warnings[0]).toContain("github (44)");
    expect(warnings[0]).toContain("notion (42)");
  });

  it("says nothing for a project within budget", async () => {
    serveCounts({ notion: 5, github: 8 });

    const runtime = await discoverMcpTools("p1", [server("notion"), server("github")]);

    expect(runtime.tools.size).toBe(13);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("MCP tools"))).toEqual([]);
  });

  it("counts what the turn actually carries, not what the server offers", async () => {
    serveCounts({ notion: 60 });
    const narrowed = { ...(server("notion") as object), toolAllowlist: ["list_notion_thing_1"] } as never;

    const runtime = await discoverMcpTools("p1", [narrowed]);

    expect(runtime.tools.size).toBe(1);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("MCP tools"))).toEqual([]);
  });
});

describe("tools a server may not use", () => {
  beforeEach(() => {
    McpClientMock.mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([...readTools("notion", 30), ...writeTools("notion", 30)]),
    }));
  });

  it("are not counted against the budget when writes are off", async () => {
    const runtime = await discoverMcpTools("p1", [server("notion")]);

    expect(runtime.tools.size).toBe(30);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("MCP tools"))).toEqual([]);
  });

  it("are counted when writes are allowed", async () => {
    const writable = { ...(server("notion") as object), allowWrites: true } as never;

    const runtime = await discoverMcpTools("p1", [writable]);

    expect(runtime.tools.size).toBe(60);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("MCP tools"))).toHaveLength(1);
  });
});

describe("a server offering one name twice", () => {
  beforeEach(() => {
    McpClientMock.mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([
        { name: "list_thing", description: "first" },
        { name: "list_thing", description: "second" },
      ]),
    }));
  });

  it("carries both, under distinct exposed names", async () => {
    const runtime = await discoverMcpTools("p1", [server("notion")]);

    expect(runtime.tools.size).toBe(2);
    expect([...runtime.tools.keys()].sort()).toEqual([
      "mcp_notion_list_thing",
      "mcp_notion_list_thing_2",
    ]);
  });

  it("carries both when the allowlist names it once, which is how the picker can tick it once", async () => {
    const narrowed = { ...(server("notion") as object), toolAllowlist: ["list_thing"] } as never;

    const runtime = await discoverMcpTools("p1", [narrowed]);

    expect(runtime.tools.size).toBe(2);
  });
});
