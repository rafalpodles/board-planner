import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const compare = vi.fn();
const userFindById = vi.fn();
const revokeUserSessions = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, getClientIp: () => "203.0.113.9" }));
vi.mock("@/lib/session", () => ({
  revokeUserSessions,
  ProvenanceError: class ProvenanceError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { compare, hash: vi.fn().mockResolvedValue("new-hash") } }));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));

const { PUT } = await import("./route");

const SESSION_ID = "sess-1";

function browserUser(username: string) {
  return { _id: "u1", username, role: "member", sessionId: SESSION_ID };
}

function machineUser(username: string) {
  return { _id: "u1", username, role: "member", viaMachineCredential: true };
}

function put(currentPassword = "current-pass") {
  return new Request("http://localhost/api/users/me/password", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword: "brand-new-pass" }),
  });
}

const ctx = () => ({ params: Promise.resolve({}) });

let record: { password: string; save: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  record = { password: "old-hash", save: vi.fn().mockResolvedValue(undefined) };
  userFindById.mockReturnValue({ select: () => Promise.resolve(record) });
  getAuthUser.mockResolvedValue(browserUser("changer"));
  compare.mockResolvedValue(true);
  revokeUserSessions.mockResolvedValue(0);
});

describe("PUT /api/users/me/password", () => {
  it("revokes the user's other sessions and spares the calling one", async () => {
    const res = await PUT(put(), ctx());

    expect(res.status).toBe(200);
    expect(record.save).toHaveBeenCalled();
    expect(revokeUserSessions).toHaveBeenCalledWith("u1", SESSION_ID);
  });

  it("revokes every session when the caller holds a machine token and has none", async () => {
    getAuthUser.mockResolvedValue(machineUser("machine-caller"));

    const res = await PUT(put(), ctx());

    expect(res.status).toBe(200);
    expect(revokeUserSessions).toHaveBeenCalledWith("u1", undefined);
  });

  it("revokes nothing when the current password is wrong", async () => {
    getAuthUser.mockResolvedValue(browserUser("wrong-pass"));
    compare.mockResolvedValue(false);

    const res = await PUT(put(), ctx());

    expect(res.status).toBe(400);
    expect(record.save).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  it("locks out after the failure threshold, before the password is compared", async () => {
    getAuthUser.mockResolvedValue(browserUser("locked-out"));
    compare.mockResolvedValue(false);

    for (let i = 0; i < 10; i++) {
      expect((await PUT(put(), ctx())).status).toBe(400);
    }
    expect(compare).toHaveBeenCalledTimes(10);

    compare.mockResolvedValue(true);
    const res = await PUT(put(), ctx());

    expect(res.status).toBe(429);
    expect(compare).toHaveBeenCalledTimes(10);
    expect(record.save).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });
});
