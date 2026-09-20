import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const agentFindById = vi.fn();
const projectUpdateOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/agent", () => ({ Agent: { findById: agentFindById } }));
vi.mock("@/models/project", () => ({ Project: { updateOne: projectUpdateOne } }));

const { PUT } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const OTHER_PROJECT = "507f1f77bcf86cd799439012";
const AGENT_ID = "507f1f77bcf86cd799439021";

function put(body: unknown) {
  return PUT(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/agent`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID }) }
  );
}

const RUNNABLE = { implementation: [{ key: "claude-code" }] };

/** The agent as stored. Scope decides who may choose it; composition decides whether it can run. */
function agent(overrides: Record<string, unknown> = {}) {
  agentFindById.mockReturnValue({
    lean: async () => ({ scope: "global", project: null, composition: RUNNABLE, ...overrides }),
  });
}

const stored = () => projectUpdateOne.mock.calls[0]?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  projectUpdateOne.mockResolvedValue({});
  agent();
});

describe("PUT /api/projects/:projectId/agent", () => {
  it("stores the agent the project should offer first", async () => {
    const res = await put({ agentId: AGENT_ID });

    expect(res.status).toBe(200);
    expect(projectUpdateOne).toHaveBeenCalledWith({ _id: PROJECT_ID }, expect.anything());
    expect(stored()).toEqual({ $set: { "worker.agent": AGENT_ID } });
  });

  // BP-458: a default that could be set and never unset left a project stuck with a suggestion
  // it had outgrown, and the picker with no way back.
  it("clears the default on the empty string", async () => {
    const res = await put({ agentId: "" });

    expect(res.status).toBe(200);
    expect(stored()).toEqual({ $set: { "worker.agent": null } });
    expect(agentFindById).not.toHaveBeenCalled();
  });

  /**
   * "Did not say" and "asked to clear" must not be the same wire message on a route an API token
   * can reach. Coercing the value to "" made both `{}` and a typo'd key answer 200 and null the
   * field — so anything that is not a string is a malformed request, not a request to clear.
   */
  it.each([
    ["an absent key", {}],
    ["null", { agentId: null }],
    ["a number", { agentId: 7 }],
    ["a typo'd key", { agent: AGENT_ID }],
  ])("refuses %s rather than reading it as a clear", async (_name, body) => {
    const res = await put(body);

    expect(res.status).toBe(400);
    expect(projectUpdateOne).not.toHaveBeenCalled();
  });

  describe("which agents may be a project's default", () => {
    it("takes a global agent", async () => {
      agent({ scope: "global" });

      expect((await put({ agentId: AGENT_ID })).status).toBe(200);
    });

    it("takes this project's own agent", async () => {
      agent({ scope: "project", project: PROJECT_ID });

      expect((await put({ agentId: AGENT_ID })).status).toBe(200);
    });

    // Otherwise a project admin could point their board at an agent composed on a board they
    // cannot see, and the picker would offer it to everyone there.
    it("refuses an agent belonging to another project", async () => {
      agent({ scope: "project", project: OTHER_PROJECT });

      const res = await put({ agentId: AGENT_ID });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That agent belongs to another project" });
      expect(projectUpdateOne).not.toHaveBeenCalled();
    });

    // A personal agent is its owner's, and a project default is offered to everybody on the
    // board — including people the owner has never met.
    it("refuses a personal agent", async () => {
      agent({ scope: "user" });

      const res = await put({ agentId: AGENT_ID });

      expect(res.status).toBe(400);
      expect(projectUpdateOne).not.toHaveBeenCalled();
    });

    it("404s for an agent that does not exist", async () => {
      agentFindById.mockReturnValue({ lean: async () => null });

      expect((await put({ agentId: AGENT_ID })).status).toBe(404);
      expect(projectUpdateOne).not.toHaveBeenCalled();
    });

    // Offering an empty agent first would suggest one that cannot run, and a task naming it is
    // never claimed at all.
    it("refuses an agent with no steps in it", async () => {
      agent({ composition: { analysis: [], implementation: [], verification: [], delivery: [] } });

      const res = await put({ agentId: AGENT_ID });

      expect(res.status).toBe(400);
      expect(projectUpdateOne).not.toHaveBeenCalled();
    });

    // The stored shape predates entries, so a bucket of bare key strings still reads as runnable
    // rather than being refused as empty.
    it("accepts a composition stored as bare keys", async () => {
      agent({ composition: { delivery: ["merge"] } });

      expect((await put({ agentId: AGENT_ID })).status).toBe(200);
    });
  });

  describe("what it refuses before looking at the body", () => {
    it("401s with no credential", async () => {
      getAuthUser.mockResolvedValue(null);

      expect((await put({ agentId: AGENT_ID })).status).toBe(401);
    });

    it("403s for somebody with no access to the project", async () => {
      check.mockResolvedValue(false);

      expect((await put({ agentId: AGENT_ID })).status).toBe(403);
    });

    /**
     * Access is not enough: picking the agent a board offers is a project-admin action, checked
     * inside the handler because the route is wrapped in withProjectAccess. A member who reaches
     * it gets 403 and nothing is written.
     */
    it("403s a member who can see the project but does not administer it", async () => {
      check.mockImplementation(async (_user, _project, level: string) => level === "access");

      const res = await put({ agentId: AGENT_ID });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Only a project admin can change this" });
      expect(projectUpdateOne).not.toHaveBeenCalled();
    });
  });
});
