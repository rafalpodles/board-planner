import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const userFindById = vi.fn();
const sendEmailOrThrow = vi.fn();
const emailSettingsSummary = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendEmailOrThrow,
  emailSettingsSummary,
  EmailNotConfiguredError: class EmailNotConfiguredError extends Error {
    constructor() {
      super("No mail server is configured");
    }
  },
}));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));

const { GET, POST } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin" };
const ctx = () => ({ params: Promise.resolve({}) });
const req = () => new Request("http://x/api/admin/email", { method: "POST" });

function adminRecord(email: string | undefined) {
  userFindById.mockReturnValue({ select: () => Promise.resolve(email ? { email } : {}) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  adminRecord("admin@example.com");
  sendEmailOrThrow.mockResolvedValue(undefined);
  emailSettingsSummary.mockReturnValue({
    configured: true,
    host: "smtp.example.com",
    port: 587,
    user: "mailer",
    from: "Board Planner <noreply@example.com>",
  });
});

describe("POST /api/admin/email", () => {
  it("sends to the caller's own address and reports it", async () => {
    const res = await POST(req(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, to: "admin@example.com" });
    expect(sendEmailOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com" })
    );
  });

  it("ignores any recipient the caller supplies", async () => {
    const res = await POST(
      new Request("http://x/api/admin/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "victim@example.com" }),
      }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(sendEmailOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com" })
    );
  });

  it("refuses when the caller has no address of their own", async () => {
    adminRecord(undefined);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(400);
    expect(sendEmailOrThrow).not.toHaveBeenCalled();
  });

  it("hands back what the mail server actually said", async () => {
    sendEmailOrThrow.mockRejectedValueOnce(
      new Error("Error upgrading connection with STARTTLS: 502 5.5.1 Command not implemented")
    );

    const res = await POST(req(), ctx());

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("STARTTLS");
  });

  it("separates having no mail server from a mail server saying no", async () => {
    const { EmailNotConfiguredError } = await import("@/lib/email");
    sendEmailOrThrow.mockRejectedValueOnce(new EmailNotConfiguredError());

    const res = await POST(req(), ctx());

    expect(res.status).toBe(409);
  });

  it("refuses a machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const res = await POST(req(), ctx());

    expect(res.status).toBe(403);
    expect(sendEmailOrThrow).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/email", () => {
  it("reports what the summary says", async () => {
    const res = await GET(new Request("http://x/api/admin/email"), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.host).toBe("smtp.example.com");
  });

  it("adds nothing to what the summary returned", async () => {
    emailSettingsSummary.mockReturnValueOnce({
      configured: true,
      host: "smtp.example.com",
      port: 587,
      user: "mailer",
      from: "x@example.com",
    });

    const body = await (await GET(new Request("http://x/api/admin/email"), ctx())).json();

    expect(Object.keys(body).sort()).toEqual(["configured", "from", "host", "port", "user"]);
  });

  it("refuses a machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const res = await GET(new Request("http://x/api/admin/email"), ctx());

    expect(res.status).toBe(403);
  });
});
