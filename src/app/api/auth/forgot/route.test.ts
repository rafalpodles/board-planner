import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindOne = vi.fn();
const sendEmail = vi.fn();
const isEmailConfigured = vi.fn();
const issueResetToken = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getClientIp: () => "203.0.113.7" }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/email", () => ({
  sendEmail,
  isEmailConfigured,
  normaliseEmail: (v: string) => v.trim().toLowerCase(),
}));
vi.mock("@/lib/password-reset", () => ({ issueResetToken }));
vi.mock("@/lib/session", () => ({
  provenanceRefusal: () => null,
  selfOrigin: () => "https://board.example.com",
}));
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne } }));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

function post(identifier: unknown = "owner") {
  return new Request("http://x/api/auth/forgot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier }),
  });
}

function found(user: unknown) {
  userFindOne.mockReturnValue({ select: () => Promise.resolve(user) });
}

const UNIFORM = "If that account exists and has an email address, a link is on its way.";

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  isEmailConfigured.mockReturnValue(true);
  issueResetToken.mockResolvedValue("cpr_deadbeef");
  sendEmail.mockResolvedValue(true);
  found({ _id: "u1", username: "owner", email: "owner@example.com", fullName: "Owner" });
});

describe("POST /api/auth/forgot", () => {
  it("sends a link carrying the token to the address on the account", async () => {
    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@example.com" })
    );
    expect(sendEmail.mock.calls[0][0].text).toContain(
      "https://board.example.com/reset?token=cpr_deadbeef"
    );
  });

  // A sign-in screen that refuses to say whether an account exists is pointless if this one will.
  // Every outcome below has to be indistinguishable from the one above.
  it.each([
    ["no such account", null],
    ["an account with no address", { _id: "u1", username: "owner", email: "" }],
  ])("answers identically for %s", async (_case, user) => {
    found(user);

    const res = await POST(post());

    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(UNIFORM);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("answers identically when the mail server refuses the message", async () => {
    sendEmail.mockResolvedValue(false);

    const res = await POST(post());

    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(UNIFORM);
  });

  it("never looks for a machine account", async () => {
    await POST(post());

    expect(userFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ kind: { $ne: "machine" } })
    );
  });

  // Both lookups run every time, in parallel: doing the second only on a miss makes the miss path
  // slower than the hit path, which is the enumeration oracle read backwards
  it("looks for the address and the username, always, and normalises both", async () => {
    await POST(post("  Owner@Example.COM "));

    expect(userFindOne).toHaveBeenCalledTimes(2);
    expect(userFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ email: "owner@example.com" })
    );
    expect(userFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ username: "owner@example.com" })
    );
  });

  // Said plainly, and not a leak: it is a fact about the deployment, not about any account. The
  // alternative is somebody waiting for a message that was never coming.
  it("says so when the instance cannot send email at all", async () => {
    isEmailConfigured.mockReturnValue(false);

    const res = await POST(post());

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("cannot send email");
    expect(issueResetToken).not.toHaveBeenCalled();
  });

  it("refuses rather than emailing a link nobody can follow", async () => {
    vi.resetModules();
    vi.doMock("@/lib/session", () => ({ provenanceRefusal: () => null, selfOrigin: () => null }));
    const { POST: withoutOrigin } = await import("./route");

    const res = await withoutOrigin(post());

    expect(res.status).toBe(500);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // Mail costs money and reputation, and the recipient is not chosen by the sender — one caller
  // must not be able to fill somebody's inbox
  it("stops answering a source that keeps asking", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await POST(post())).status).toBe(200);
    }

    const res = await POST(post());

    expect(res.status).toBe(429);
    expect(sendEmail).toHaveBeenCalledTimes(10);
  });

  it("counts a request that found nothing, so the cheap path is metered too", async () => {
    found(null);
    for (let i = 0; i < 10; i++) await POST(post());

    found({ _id: "u1", username: "owner", email: "owner@example.com" });
    const res = await POST(post());

    expect(res.status).toBe(429);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("wants something to look for", async () => {
    expect((await POST(post("   "))).status).toBe(400);
    expect((await POST(post(42))).status).toBe(400);
  });

  /**
   * BP-322. The throttle moved above the body read, and nothing said so: reverting the reorder left
   * every test on this route and every end-to-end test green. An oversized body is what tells the
   * two orders apart — 429 means the throttle ran first, 413 means the server read 70 KB from a
   * caller it had already decided to refuse.
   */
  describe("the order the checks run in", () => {
    const oversized = () =>
      new Request("http://x/api/auth/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "x".repeat(70 * 1024) }),
      });

    it("refuses a throttled caller without reading its body", async () => {
      isEmailConfigured.mockReturnValue(true);
      found(null);
      for (let i = 0; i < 11; i++) await POST(post("someone"));

      expect((await POST(oversized())).status).toBe(429);
    });

    it("still caps the body of a caller it has not throttled — the control", async () => {
      isEmailConfigured.mockReturnValue(true);
      found(null);

      expect((await POST(oversized())).status).toBe(413);
    });
  });
});
