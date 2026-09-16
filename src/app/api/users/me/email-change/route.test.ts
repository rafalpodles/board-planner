import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const pendingEmailChange = vi.fn();
const cancelEmailChange = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/email-change", () => ({ pendingEmailChange, cancelEmailChange }));

const { GET, DELETE } = await import("./route");

const request = (method: string) =>
  new Request("https://app.example.com/api/users/me/email-change", {
    method,
    headers: { "sec-fetch-site": "same-origin" },
  });
const ctx = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  pendingEmailChange.mockResolvedValue({ email: "new@example.com", expiresAt: new Date(0) });
});

// BP-359 review: like PUT /api/users/me, the recovery address is not a machine credential's business
describe("/api/users/me/email-change", () => {
  it("shows and cancels a pending change for a person", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", viaMachineCredential: false });

    expect(await (await GET(request("GET"), ctx)).json()).toMatchObject({ pending: { email: "new@example.com" } });
    expect((await DELETE(request("DELETE"), ctx)).status).toBe(200);
    expect(cancelEmailChange).toHaveBeenCalledWith("u1");
  });

  it("refuses a machine credential either way", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", viaMachineCredential: true });

    expect((await GET(request("GET"), ctx)).status).toBe(403);
    expect((await DELETE(request("DELETE"), ctx)).status).toBe(403);
    expect(pendingEmailChange).not.toHaveBeenCalled();
    expect(cancelEmailChange).not.toHaveBeenCalled();
  });
});
