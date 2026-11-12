import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const originFor = vi.fn();
const projectFindOne = vi.fn();
const projectLean = vi.fn();
const oauthExists = vi.fn();
const agentLean = vi.fn();
const taskLean = vi.fn();
const workerLean = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/organisation-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
  originFor,
}));
vi.mock("@/lib/machine-limit", () => ({ claimingMachineIds: async () => null }));
const check = vi.fn();
vi.mock("@/lib/grants", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/grants")>()), check }));
vi.mock("@/models/project", () => ({
  Project: {
    findOne: (...a: unknown[]) => (projectFindOne(...a), { sort: () => ({ lean: projectLean }) }),
  },
}));
vi.mock("@/models/oauthToken", () => ({ OAuthToken: { exists: oauthExists } }));
vi.mock("@/models/agent", () => ({ Agent: { findOne: () => ({ lean: agentLean }) } }));
vi.mock("@/models/task", () => ({ Task: { findOne: () => ({ sort: () => ({ lean: taskLean }) }) } }));
vi.mock("@/models/worker", () => ({ Worker: { find: () => ({ lean: workerLean }) } }));

const { GET } = await import("./route");

const USER = "507f1f77bcf86cd799439011";
const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const AGENT = "69a52e3b399b27d3cbb2c5a6";
const TASK = "69a52e3b399b27d3cbb2c5a7";

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: USER, role: "admin", username: "alex" });
  originFor.mockResolvedValue("https://acme.board-planner.com");
  oauthExists.mockResolvedValue(null);
  projectLean.mockResolvedValue(null);
  agentLean.mockResolvedValue(null);
  taskLean.mockResolvedValue(null);
  workerLean.mockResolvedValue([]);
  check.mockResolvedValue(true);
});

async function read(query = "") {
  const res = await GET(new Request(`http://x/api/onboarding/agent-setup${query}`), { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/onboarding/agent-setup", () => {
  it("builds the prompt for this organisation's own address", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.prompt).toContain("https://acme.board-planner.com/api/mcp");
    expect(body.run).toBeNull();
  });

  it("refuses to hand out a prompt with no address in it", async () => {
    originFor.mockResolvedValue(null);
    expect((await read()).status).toBe(500);
  });

  it("only counts a board this person created since the screen opened", async () => {
    const since = "2026-11-12T10:00:00.000Z";
    const { body } = await read(`?since=${since}`);
    expect(body.since).toBe(since);
    const filter = projectFindOne.mock.calls[0][0];
    expect(String(filter.createdBy)).toBe(USER);
    expect(filter.createdAt.$gte.toISOString()).toBe(since);
  });

  it("starts counting now when since is missing, malformed or in the future", async () => {
    for (const query of ["", "?since=nonsense", "?since=2999-01-01T00:00:00Z"]) {
      const before = Date.now();
      const { body } = await read(query);
      expect(new Date(body.since).getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("offers Run with the board's default agent, its first task and its approved column", async () => {
    oauthExists.mockResolvedValue({ _id: "t" });
    projectLean.mockResolvedValue({
      _id: PROJECT,
      key: "PAY",
      name: "Payments API",
      repositoryUrl: "https://github.com/acme/api",
      worker: { enabled: true, agent: AGENT },
    });
    agentLean.mockResolvedValue({ _id: AGENT, name: "Default" });
    taskLean.mockResolvedValue({ _id: TASK, taskNumber: 1, title: "README section", status: "planned" });

    const { body } = await read();
    expect(body.run).toEqual({
      projectId: PROJECT,
      projectKey: "PAY",
      taskId: TASK,
      taskNumber: 1,
      agentId: AGENT,
      status: "todo",
    });
    const machine = body.steps.find((s: { key: string }) => s.key === "machine");
    expect(machine.state).toBe("waiting");
  });

  it("offers no Run while the board names no default agent", async () => {
    projectLean.mockResolvedValue({ _id: PROJECT, key: "PAY", name: "P", repositoryUrl: "https://github.com/a/b", worker: {} });
    taskLean.mockResolvedValue({ _id: TASK, taskNumber: 1, title: "t", status: "planned" });
    expect((await read()).body.run).toBeNull();
  });

  it("offers no Run for a first task that already moved past approval", async () => {
    projectLean.mockResolvedValue({ _id: PROJECT, key: "PAY", name: "P", repositoryUrl: "https://github.com/a/b", worker: { agent: AGENT } });
    agentLean.mockResolvedValue({ _id: AGENT, name: "Default" });
    taskLean.mockResolvedValue({ _id: TASK, taskNumber: 1, title: "t", status: "done" });
    expect((await read()).body.run).toBeNull();
  });

  it("does not show a board its creator can no longer reach", async () => {
    projectLean.mockResolvedValue({ _id: PROJECT, key: "PAY", name: "Secret", repositoryUrl: "https://github.com/a/b", worker: {} });
    check.mockResolvedValue(false);
    const { body } = await read("?since=2020-01-01T00:00:00Z");
    expect(JSON.stringify(body.steps)).not.toContain("Secret");
  });

  it("refuses a machine credential: this is a person's screen", async () => {
    getAuthUser.mockResolvedValue({ _id: USER, role: "admin", username: "alex", viaMachineCredential: true });
    expect((await read()).status).toBe(403);
  });

  it("offers no Run for a first task a machine is already running", async () => {
    projectLean.mockResolvedValue({ _id: PROJECT, key: "PAY", name: "P", repositoryUrl: "https://github.com/a/b", worker: { agent: AGENT } });
    agentLacksNothing();
    taskLean.mockResolvedValue({ _id: TASK, taskNumber: 1, title: "t", status: "todo", execution: { runId: "run-1" } });
    expect((await read()).body.run).toBeNull();
  });

  it("counts the agent as connected once its board exists, whatever credential it used", async () => {
    projectLean.mockResolvedValue({ _id: PROJECT, key: "PAY", name: "P", repositoryUrl: "https://github.com/a/b", worker: {} });
    const { body } = await read();
    expect(body.steps.find((s: { key: string }) => s.key === "agent").state).toBe("done");
  });

  it("does not take an MCP connection made before the screen opened for this agent's", async () => {
    await read("?since=2026-11-12T10:00:00.000Z");
    expect(oauthExists.mock.calls[0][0].createdAt.$gte.toISOString()).toBe("2026-11-12T10:00:00.000Z");
  });
});

function agentLacksNothing() {
  agentLean.mockResolvedValue({ _id: AGENT, name: "Default" });
}
