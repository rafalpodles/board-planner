import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const find = vi.fn();
const lean = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check };
});
const chain = { sort: () => chain, limit: () => chain, populate: () => chain, lean };
vi.mock("@/models/projectAuditLog", () => ({
  ProjectAuditLog: { find: (...a: unknown[]) => (find(...a), chain) },
}));
vi.mock("@/models/project", () => ({
  Project: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve({ key: "BP" }) }) }) },
}));

const { GET } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });
const exportOf = (query = "") => GET(new Request(`http://x/api/projects/${PROJECT}/audit/export${query}`), { params });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member", viaMachineCredential: false });
  check.mockResolvedValue(true);
  lean.mockResolvedValue([
    { _id: "a1", createdAt: new Date("2026-10-10T10:00:00Z"), user: { username: "rafal" }, action: "settings_updated", detail: "=cmd()" },
  ]);
});

describe("GET project audit export", () => {
  it("refuses a member who does not own the project", async () => {
    check.mockResolvedValue(false);
    expect((await exportOf()).status).toBe(403);
    expect(find).not.toHaveBeenCalled();
  });

  it("refuses a machine credential, even the owner's", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", role: "member", viaMachineCredential: true });
    expect((await exportOf()).status).toBe(403);
    expect(find).not.toHaveBeenCalled();
  });

  it("hands the owner a CSV download named for the project", async () => {
    const response = await exportOf("?format=csv");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="bp-audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(await response.text()).toBe("createdAt,actor,action,detail\r\n2026-10-10T10:00:00.000Z,rafal,settings_updated,'=cmd()\r\n");
  });

  it("refuses a format it does not write", async () => {
    expect((await exportOf("?format=xlsx")).status).toBe(400);
  });
});
