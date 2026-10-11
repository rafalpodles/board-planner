import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const accountExport = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, getClientIp: () => "203.0.113.9" }));
vi.mock("@/lib/session", () => ({ ProvenanceError: class ProvenanceError extends Error {} }));
vi.mock("@/lib/account-export", () => ({ accountExport }));

const { GET } = await import("./route");
const context = { params: Promise.resolve({}) };
const get = () => new Request("https://app.example.com/api/users/me/export", { headers: { "sec-fetch-site": "same-origin" } });

beforeEach(() => {
  vi.clearAllMocks();
  accountExport.mockResolvedValue({ account: { username: "jan" } });
});

describe("GET /api/users/me/export", () => {
  it("serves the person's own data as a JSON download that is never cached", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", username: "jan", kind: "human", viaMachineCredential: false });

    const res = await GET(get(), context);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="jan-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await res.text())).toEqual({ account: { username: "jan" } });
    expect(accountExport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ _id: "u1" }));
  });

  it("refuses a machine credential, which could otherwise carry the data out unattended", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", username: "jan", kind: "human", viaMachineCredential: true });

    expect((await GET(get(), context)).status).toBe(403);
    expect(accountExport).not.toHaveBeenCalled();
  });

  it("answers 401 to nobody", async () => {
    getAuthUser.mockResolvedValue(null);
    expect((await GET(get(), context)).status).toBe(401);
  });
});
