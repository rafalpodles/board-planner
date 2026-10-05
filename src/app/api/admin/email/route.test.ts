import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const userFindOne = vi.fn();
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
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne } }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

const { GET, POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const ADMIN = { _id: "admin-1", role: "admin" };
const ctx = () => ({ params: Promise.resolve({}) });
const req = () => new Request("http://x/api/admin/email", { method: "POST" });

function adminRecord(email: string | undefined) {
  userFindOne.mockReturnValue({ select: () => Promise.resolve(email ? { email } : {}) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  getAuthUser.mockResolvedValue(ADMIN);
  adminRecord("admin@example.com");
  sendEmailOrThrow.mockResolvedValue(undefined);
  emailSettingsSummary.mockReturnValue({
    managedByPlatform: false,
    configured: true,
    host: "smtp.example.com",
    port: 587,
    user: "mailer",
    from: "Board Planner <noreply@example.com>",
  });
});

describe("POST /api/admin/email", () => {
  it("on a shared instance, reports a refusal without the mail server's own words, which name the platform's host (BP-892)", async () => {
    emailSettingsSummary.mockReturnValue({ managedByPlatform: true, configured: true, from: "Board Planner <noreply@example.com>" });
    sendEmailOrThrow.mockRejectedValue(new Error("getaddrinfo ENOTFOUND smtp.platform.example"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req(), ctx());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The service's mail server did not accept the message." });
    const sent = sendEmailOrThrow.mock.calls[0][0] as { text: string };
    expect(sent.text).not.toMatch(/\bHost\b/);
    expect(sent.text).not.toContain("undefined");
  });

  it("holds one administrator to five test messages a window (BP-892)", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(req(), ctx())).status).toBe(200);

    const refused = await POST(req(), ctx());

    expect(refused.status).toBe(429);
    expect(sendEmailOrThrow).toHaveBeenCalledTimes(5);
  });

  it("sends to the caller's own address and reports it", async () => {
    const res = await POST(req(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, to: "admin@example.com" });
    expect(sendEmailOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com" })
    );
  });

  // A recipient field would make an authenticated instance a mailer for arbitrary addresses. The
  // body is ignored entirely, so a caller cannot smuggle one in.
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

  // The whole point of the endpoint: everywhere else this failure is swallowed, which is why a
  // misconfigured deployment is indistinguishable from a working one
  it("hands back what the mail server actually said", async () => {
    sendEmailOrThrow.mockRejectedValueOnce(
      new Error("Error upgrading connection with STARTTLS: 502 5.5.1 Command not implemented")
    );

    const res = await POST(req(), ctx());

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("STARTTLS");
  });

  // Not 502: nothing was contacted, and the screen reads the status to decide whether to blame a
  // mail server. "The mail server refused it" above "No mail server is configured" is nonsense.
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

  // The route forwards whatever the summary returns, so it cannot be the thing that keeps the
  // password out — that guarantee belongs to emailSettingsSummary and is asserted in email.test.ts
  // against the real function. What this proves is that the route adds nothing of its own.
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
