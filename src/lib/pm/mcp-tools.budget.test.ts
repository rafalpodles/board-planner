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

/**
 * BP-569. How many tools a turn carries is decided by the remote server, so a project that worked
 * can break with no deploy and no settings change. The only way that is diagnosable after the fact
 * is if the turn says so at the time.
 */
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

  // The control. A budget that warned about everything would be as useless as one that warned
  // about nothing, and the narrowed configuration below is the one that fixed BP in production.
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

/**
 * Every server above offers only read-safe tools, so deleting the `allowWrites` filter from
 * discovery changed none of their counts. That filter is what the picker's disabled checkboxes
 * and the banner's numbers both rest on (BP-569 review 3).
 */
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

  // The control: with writes allowed the same server carries all sixty and trips the budget
  it("are counted when writes are allowed", async () => {
    const writable = { ...(server("notion") as object), allowWrites: true } as never;

    const runtime = await discoverMcpTools("p1", [writable]);

    expect(runtime.tools.size).toBe(60);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("MCP tools"))).toHaveLength(1);
  });
});
