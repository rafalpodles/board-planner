import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthUser, updateSettings, logInstanceAudit } = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  updateSettings: vi.fn(),
  logInstanceAudit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/models/settings", () => ({
  getSettings: vi.fn(),
  updateSettings,
}));

const { PUT } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const ADMIN = { _id: "admin-1", username: "root", role: "admin", viaMachineCredential: false };

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSettings.mockImplementation(async (_db, update) => update.$set);
});

// BP-326: the model behind every project's PM and AI Assist
describe("PUT /api/settings", () => {
  it("refuses an admin's machine credential and writes nothing", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const res = await put({ aiModel: "some/model" });

    expect(res.status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("refuses an oversized AI model name", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const res = await put({ aiModel: "m".repeat(10_000) });

    expect(res.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("writes nothing for a default turn cap, which an older client may still send: there is none", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await put({ pmDefaultDailyTurnCap: 250 });
    expect(updateSettings).not.toHaveBeenCalled();

    await put({ aiModel: "some/model", pmDefaultDailyTurnCap: 250 });
    expect(updateSettings).toHaveBeenCalledWith(scopedToDefaultOrganisation(), { $set: { aiModel: "some/model" } });
  });

  it("writes nothing for a PM default model, which an older client may still send: the PM runs on the one model", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const res = await put({ pmDefaultModel: "some/model" });

    expect(res.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("writes the change for an interactive admin and records who made it", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const res = await put({ aiModel: "some/model" });

    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(scopedToDefaultOrganisation(), {
      $set: { aiModel: "some/model" },
    });
    expect(logInstanceAudit).toHaveBeenCalledWith(scopedToDefaultOrganisation(), {
      action: "instance_settings_changed",
      user: "admin-1",
      actorUsername: "root",
      detail: "aiModel: some/model",
    });
  });
});
