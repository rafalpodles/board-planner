import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const find = vi.fn();
const lean = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
const chain = { sort: () => chain, limit: () => chain, populate: () => chain, lean };
vi.mock("@/models/instanceAuditLog", () => ({
  InstanceAuditLog: { find: (...a: unknown[]) => (find(...a), chain) },
}));

const { GET } = await import("./route");
const exportOf = (query = "") => GET(new Request(`http://x/api/admin/audit/export${query}`), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "admin", viaMachineCredential: false });
  lean.mockResolvedValue([
    { _id: "a1", createdAt: new Date("2026-10-10T10:00:00Z"), user: null, actorUsername: "", action: "worker_disabled", target: "mbp", detail: "" },
  ]);
});

describe("GET instance audit export", () => {
  it("refuses somebody who is not an administrator", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", role: "member", viaMachineCredential: false });
    expect((await exportOf()).status).toBe(403);
    expect(find).not.toHaveBeenCalled();
  });

  it("refuses an administrator's machine credential", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", role: "admin", viaMachineCredential: true });
    expect((await exportOf()).status).toBe(403);
    expect(find).not.toHaveBeenCalled();
  });

  it("names a row nobody wrote as the system, one JSON object per line", async () => {
    const response = await exportOf("?format=ndjson");
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(JSON.parse((await response.text()).trim())).toEqual({
      createdAt: "2026-10-10T10:00:00.000Z",
      actor: "system",
      action: "worker_disabled",
      target: "mbp",
      detail: "",
    });
  });
});
