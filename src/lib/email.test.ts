import { describe, it, expect, vi, beforeEach } from "vitest";
import { APP_NAME, APP_DOMAIN } from "@/lib/brand";

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

  // The screen has two branches and this decides which one an admin gets. Since BP-465 the e2e run
  // has a mail server, so the unconfigured branch is reachable there only through a stubbed route —
  // this is the one place left that asserts the mapping against the environment itself.
  it("reports configured only when the host, the user and the password are all present", async () => {
    const cases = [
      [{ host: "smtp.example.com", user: "mailer", pass: "secret" }, true],
      [{ host: "", user: "mailer", pass: "secret" }, false],
      [{ host: "smtp.example.com", user: "", pass: "secret" }, false],
      [{ host: "smtp.example.com", user: "mailer", pass: "" }, false],
    ] as const;

    for (const [env, expected] of cases) {
      vi.resetModules();
      vi.stubEnv("SMTP_HOST", env.host);
      vi.stubEnv("SMTP_USER", env.user);
      vi.stubEnv("SMTP_PASS", env.pass);
      const fresh = await import("./email");
      const label = JSON.stringify(env);
      expect(fresh.emailSettingsSummary().configured, label).toBe(expected);
      expect(fresh.isEmailConfigured(), label).toBe(expected);
    }

    // Put back what the rest of this file was imported against
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_USER", "mailer");
    vi.stubEnv("SMTP_PASS", "secret");
  });

  // The two fields a deployment is allowed to leave alone. The mail screen prints both, so a
  // default that stopped applying would put an empty port and an empty sender in front of an admin
  // — and `sendMail` would hand the mail server a message from nobody. Stubbed empty rather than
  // deleted: `||` treats the two the same, and the empty string is the one a `??` would get wrong.
  it("supplies the port and the sender a deployment left empty", async () => {
    vi.resetModules();
    vi.stubEnv("SMTP_PORT", "");
    vi.stubEnv("SMTP_FROM", "");
    const fresh = await import("./email");

    expect(fresh.emailSettingsSummary().port).toBe(587);
    // Against the brand constants the default is built from: `/^.+ <.+@.+>$/` would be satisfied
    // by any name and any domain, including somebody else's
    expect(fresh.emailSettingsSummary().from).toBe(`${APP_NAME} <noreply@${APP_DOMAIN}>`);

    vi.stubEnv("SMTP_PORT", "2525");
    vi.stubEnv("SMTP_FROM", "Someone <someone@example.com>");
    vi.resetModules();
    const given = await import("./email");

    // Reported as it was given, rather than as a constant that happens to match the default
    expect(given.emailSettingsSummary()).toMatchObject({
      host: "smtp.example.com",
      port: 2525,
      user: "mailer",
      from: "Someone <someone@example.com>",
    });

    vi.unstubAllEnvs();
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_USER", "mailer");
    vi.stubEnv("SMTP_PASS", "secret");
  });
});

describe("addresses", () => {
  it("normalises what people actually type", () => {
    expect(normaliseEmail("  Owner@Example.COM ")).toBe("owner@example.com");
  });

  it("rejects the typos that would silently swallow a reset", () => {
    for (const bad of ["", "owner", "owner@", "@example.com", "a b@example.com", "a@b@c.com"]) {
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
      "owner@example.com",
      "owner+board@example.co.uk",
      "r.example@other-domain.com",
      "owner_1@sub.domain.example.org",
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
