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

  it("both send the same message when the server is willing", async () => {
    await expect(sendEmail(MESSAGE)).resolves.toBe(true);
    await expect(sendEmailOrThrow(MESSAGE)).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(2);
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
    for (const bad of ["", "rafal", "rafal@", "@example.com", "rafal@example", "a b@example.com"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it("accepts addresses people really have", () => {
    for (const good of [
      "rafal@example.com",
      "rafal+board@example.co.uk",
      "r.podles@spyro-soft.com",
      "rafal_1@sub.domain.example.org",
    ]) {
      expect(isValidEmail(good), good).toBe(true);
    }
  });
});
