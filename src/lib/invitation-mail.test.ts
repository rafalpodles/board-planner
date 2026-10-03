import { describe, it, expect, vi, beforeEach } from "vitest";

const isEmailConfigured = vi.fn();
const sendEmail = vi.fn();

vi.mock("@/lib/email", () => ({ isEmailConfigured, sendEmail }));

const { deliverInvitation, invitationLink } = await import("./invitation-mail");

const MAIL = {
  to: "ada@example.com",
  token: "cpi_secret",
  origin: "https://planner.example",
  inviterName: "Grace",
  role: "member" as const,
  boards: [{ name: "Orbit", relation: "owner" as const }],
};

beforeEach(() => {
  vi.clearAllMocks();
  isEmailConfigured.mockReturnValue(true);
  sendEmail.mockResolvedValue(true);
});

describe("delivering an invitation", () => {
  it("mails the link and keeps it out of the answer", async () => {
    const result = await deliverInvitation(MAIL);

    expect(result).toEqual({ delivery: "email" });
    const sent = sendEmail.mock.calls[0][0];
    expect(sent.to).toBe("ada@example.com");
    expect(sent.text).toContain(invitationLink(MAIL.origin, MAIL.token));
    expect(sent.text).toContain("Orbit");
  });

  // BP-844. With passwords off the invitee chooses a username and signs in with a provider
  it("asks for a password only while passwords sign anybody in", async () => {
    await deliverInvitation(MAIL);
    expect(sendEmail.mock.calls[0][0].text).toContain("Choose a username and a password");

    process.env.PASSWORD_SIGN_IN = "off";
    try {
      await deliverInvitation(MAIL);
      const text = sendEmail.mock.calls[1][0].text;
      expect(text).toContain("Sign in with your provider and choose a username");
      expect(text).not.toContain("a password");
    } finally {
      delete process.env.PASSWORD_SIGN_IN;
    }
  });

  it("hands the link back when the instance has no mail server", async () => {
    isEmailConfigured.mockReturnValue(false);

    const result = await deliverInvitation(MAIL);

    expect(result).toEqual({
      delivery: "link",
      link: "https://planner.example/invite?token=cpi_secret",
      reason: "no_mail_server",
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("hands the link back when the mail server refused it", async () => {
    sendEmail.mockResolvedValue(false);

    expect(await deliverInvitation(MAIL)).toMatchObject({ delivery: "link", reason: "mail_failed" });
  });
});
