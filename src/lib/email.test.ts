import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

vi.stubEnv("SMTP_HOST", "smtp.example.com");
vi.stubEnv("SMTP_USER", "mailer");
vi.stubEnv("SMTP_PASS", "secret");

const { sendEmail, sendEmailOrThrow, isValidEmail, normaliseEmail, emailSettingsSummary } =
  await import("./email");

const MESSAGE = { to: "someone@example.com", subject: "s", text: "t" };

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue(undefined);
});

describe("the two ways to send", () => {
  // Notifications are fire-and-forget: a mail server having a bad afternoon must not take a task
  // update down with it. This is why the failure is invisible, and why the test-send exists.
  it("sendEmail swallows the failure and answers false", async () => {
    sendMail.mockRejectedValueOnce(new Error("535 authentication failed"));

    await expect(sendEmail(MESSAGE)).resolves.toBe(false);
  });

  it("sendEmailOrThrow hands the failure back untouched", async () => {
    sendMail.mockRejectedValueOnce(new Error("535 authentication failed"));

    await expect(sendEmailOrThrow(MESSAGE)).rejects.toThrow("535 authentication failed");
  });

  it("both hand the mail server the same message", async () => {
    await expect(sendEmail(MESSAGE)).resolves.toBe(true);
    await expect(sendEmailOrThrow(MESSAGE)).resolves.toBeUndefined();

    expect(sendMail).toHaveBeenCalledTimes(2);
    // The payload, not just the call count: sending `{from: undefined, to: undefined}` twice would
    // satisfy a count, and the recipient is the one field that must never be lost
    expect(sendMail.mock.calls[0][0]).toEqual(sendMail.mock.calls[1][0]);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: MESSAGE.to,
        subject: MESSAGE.subject,
        text: MESSAGE.text,
        html: MESSAGE.text,
        from: expect.stringContaining("@"),
      })
    );
  });
});

describe("emailSettingsSummary", () => {
  it("carries no password", () => {
    expect(JSON.stringify(emailSettingsSummary())).not.toContain("secret");
  });
});

describe("addresses", () => {
  it("normalises what people actually type", () => {
    expect(normaliseEmail("  Rafal@Example.COM ")).toBe("rafal@example.com");
  });

  it("rejects the typos that would silently swallow a reset", () => {
    for (const bad of ["", "rafal", "rafal@", "@example.com", "a b@example.com", "a@b@c.com"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  // These deliver to somebody else's mailbox while being a different string to the unique index,
  // so uniqueness would let one person quietly claim another's inbox — and, from slice 3, receive
  // a genuine reset link addressed to them
  it("rejects the forms that reach one mailbox under two names", () => {
    for (const squat of [
      "<victim@corp.com>",
      "X<victim@corp.com>",
      "victim@corp.com.",
      "a,b@example.com",
      "a;b@example.com",
      "victim@corp..com",
    ]) {
      expect(isValidEmail(squat), squat).toBe(false);
    }
  });

  it("accepts addresses people really have", () => {
    for (const good of [
      "rafal@example.com",
      "rafal+board@example.co.uk",
      "r.example@other-domain.com",
      "rafal_1@sub.domain.example.org",
      // Ordinary on the company network this product is self-hosted on. Demanding a dot would lock
      // those deployments out of their own email.
      "admin@intranet",
      "user@localhost",
    ]) {
      expect(isValidEmail(good), good).toBe(true);
    }
  });

  it("refuses an address longer than a mail server would accept", () => {
    expect(isValidEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});
