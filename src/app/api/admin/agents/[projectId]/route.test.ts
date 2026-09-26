import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const projectFindByIdAndUpdate = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/models/project", () => ({ Project: { findByIdAndUpdate: projectFindByIdAndUpdate } }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
// The schema's own casting is exercised by settings-audit.test.ts and the e2e; here the update is
// laid over the before-image as written
vi.mock("@/lib/project-write-images", () => ({
  projectWriteImages: (before: Record<string, unknown>, updates: Record<string, unknown>) => {
    const after = JSON.parse(JSON.stringify(before));
    for (const [path, value] of Object.entries(updates)) {
      const keys = path.split(".");
      let node = after;
      for (const key of keys.slice(0, -1)) node = node[key] ??= {};
      node[keys[keys.length - 1]] = value;
    }
    return { before, after: { ...after, toObject: () => after, populate: async () => undefined } };
  },
}));

const { PATCH } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const ADMIN = "507f1f77bcf86cd799439031";

function patch(body: unknown, projectId = PROJECT_ID) {
  return PATCH(
    new Request(`http://localhost/api/admin/agents/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) }
  );
}

/** The project as the update found it. */
function stored(pm: Record<string, unknown> = {}) {
  projectFindByIdAndUpdate.mockReturnValue({
    lean: async () => ({ _id: PROJECT_ID, key: "TP", pm }),
  });
}

const written = () => projectFindByIdAndUpdate.mock.calls[0]?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: ADMIN, role: "admin", viaMachineCredential: false });
  logProjectAudit.mockResolvedValue(undefined);
  stored({ enabled: true, model: "x/y", dailyTurnCap: 50 });
});

describe("PATCH /api/admin/agents/:projectId", () => {
  it("writes only the fields the request named", async () => {
    const res = await patch({ enabled: false });

    expect(res.status).toBe(200);
    expect(written()).toEqual({ $set: { "pm.enabled": false } });
  });

  it("writes several at once", async () => {
    await patch({ enabled: true, lockedByInstance: true, model: " a/b ", dailyTurnCap: 12 });

    expect(written()).toEqual({
      $set: {
        "pm.enabled": true,
        "pm.lockedByInstance": true,
        "pm.model": "a/b",
        "pm.dailyTurnCap": 12,
      },
    });
  });

  it("answers with the shape the settings screen reads, not the whole project", async () => {
    stored({ enabled: true, lockedByInstance: false, model: "x/y", dailyTurnCap: 7 });

    const body = await (await patch({ enabled: true })).json();

    expect(body).toEqual({
      _id: PROJECT_ID,
      key: "TP",
      enabled: true,
      lockedByInstance: false,
      model: "x/y",
      dailyTurnCap: 7,
    });
  });

  it("reports absent pm settings as off rather than undefined", async () => {
    stored({});

    const body = await (await patch({ lockedByInstance: true })).json();

    expect(body).toMatchObject({ enabled: false, lockedByInstance: true, model: "", dailyTurnCap: 0 });
  });

  it("answers with what it wrote over what it found", async () => {
    stored({ enabled: true, lockedByInstance: false, model: "x/y", dailyTurnCap: 7 });

    const body = await (await patch({ enabled: false, model: "a/b" })).json();

    expect(body).toMatchObject({ enabled: false, lockedByInstance: false, model: "a/b", dailyTurnCap: 7 });
  });

  // The audit row is what an instance admin's reach over somebody else's board is read from
  // afterwards, so it names each field with its value before and after, and says who it was.
  it("records what was changed on the project's audit log", async () => {
    await patch({ enabled: false, dailyTurnCap: 0 });

    expect(logProjectAudit).toHaveBeenCalledWith(
      PROJECT_ID,
      ADMIN,
      "settings_updated",
      ["Instance admin console", "PM agent: on → off", "PM turns per day: 50 → server default"]
    );
  });

  it("records nothing when every field named already held that value", async () => {
    const res = await patch({ enabled: true, model: "x/y" });

    expect(res.status).toBe(200);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  describe("what it refuses", () => {
    /**
     * BP-306. An unscoped admin API token keeps `role: "admin"` and so passes withAdmin — but a
     * machine credential must not reach a kill switch. The counterpart action was already gated
     * this way and the asymmetry was the bug.
     */
    it("403s a machine credential even though it carries the admin role", async () => {
      getAuthUser.mockResolvedValue({ _id: ADMIN, role: "admin", viaMachineCredential: true });

      const res = await patch({ enabled: false });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Interactive admin session required" });
      expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("403s a member", async () => {
      getAuthUser.mockResolvedValue({ _id: "u2", role: "member", viaMachineCredential: false });

      expect((await patch({ enabled: false })).status).toBe(403);
      expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("401s with no credential", async () => {
      getAuthUser.mockResolvedValue(null);

      expect((await patch({ enabled: false })).status).toBe(401);
    });

    it("400s a project id that is not an ObjectId, before reading the body", async () => {
      const res = await patch({ enabled: false }, "not-an-id");

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid project id" });
      expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    /**
     * Deliberately narrow: this endpoint exists so an instance admin can govern agents, not as a
     * second way to write arbitrary project config. A body naming nothing it recognises is a
     * refusal, not an empty $set that would answer 200 for a typo.
     */
    it.each([
      ["a body with nothing it governs", { name: "Renamed", pm: { enabled: true } }],
      ["an empty body", {}],
    ])("400s %s", async (_name, body) => {
      const res = await patch(body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Nothing to update" });
      expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    it.each([
      ["enabled as a string", { enabled: "yes" }],
      ["lockedByInstance as a number", { lockedByInstance: 1 }],
      ["model as an object", { model: { name: "x" } }],
      ["a model past a hundred characters", { model: "x".repeat(101) }],
      ["a fractional turn cap", { dailyTurnCap: 1.5 }],
      ["a negative turn cap", { dailyTurnCap: -1 }],
      ["a turn cap past a thousand", { dailyTurnCap: 1001 }],
    ])("400s %s", async (_name, body) => {
      expect((await patch(body)).status).toBe(400);
      expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("accepts the ends of the turn-cap range", async () => {
      expect((await patch({ dailyTurnCap: 0 })).status).toBe(200);
      expect((await patch({ dailyTurnCap: 1000 })).status).toBe(200);
    });

    it("404s a project that does not exist", async () => {
      projectFindByIdAndUpdate.mockReturnValue({ lean: async () => null });

      const res = await patch({ enabled: false });

      expect(res.status).toBe(404);
      expect(logProjectAudit).not.toHaveBeenCalled();
    });
  });
});
