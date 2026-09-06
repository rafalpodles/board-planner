import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmail = vi.fn().mockResolvedValue(true);
const isEmailConfigured = vi.fn(() => true);
const selfOrigin = vi.fn<() => string | null>(() => "https://app.example.com");

vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  isEmailConfigured: () => isEmailConfigured(),
}));
vi.mock("@/lib/session", () => ({ selfOrigin: () => selfOrigin() }));

const { notifyPasswordChanged, notifyAddressChanged, notifyCredentialCreated, maskAddress } =
  await import("@/lib/security-mail");

const sent = () => sendEmail.mock.calls.at(-1)?.[0] as { to: string; subject: string; html: string; text: string };

beforeEach(() => {
  sendEmail.mockClear();
  isEmailConfigured.mockReturnValue(true);
  selfOrigin.mockReturnValue("https://app.example.com");
});

describe("notifyPasswordChanged", () => {
  it("warns hard when a reset link did it, because that is the takeover case", async () => {
    await notifyPasswordChanged({
      email: "owner@example.com",
      username: "owner",
      how: "reset_link",
      from: "from 203.0.113.9",
    });

    expect(sent().to).toBe("owner@example.com");
    expect(sent().text).toContain("whoever did it can sign in as you right now");
    expect(sent().text).toContain("from 203.0.113.9");
  });

  it("names the administrator and says the password was not sent", async () => {
    await notifyPasswordChanged({
      email: "owner@example.com",
      username: "owner",
      how: "admin",
      actor: "owner",
    });

    expect(sent().text).toContain("(owner)");
    expect(sent().text).toContain("not sent by email");
    // The admin case is not a takeover alarm — somebody they can ask did it on purpose
    expect(sent().text).not.toContain("can sign in as you right now");
  });

  it("says nothing to an account with no address", async () => {
    await notifyPasswordChanged({ email: "", username: "owner", how: "admin" });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("swallows a mail server having a bad afternoon", async () => {
    sendEmail.mockRejectedValueOnce(new Error("smtp is down"));

    await expect(
      notifyPasswordChanged({ email: "owner@example.com", username: "owner", how: "admin" })
    ).resolves.toBeUndefined();
  });
});

describe("notifyAddressChanged", () => {
  it("goes to the address losing the account and shows the new one masked", async () => {
    await notifyAddressChanged({
      previousEmail: "old@example.com",
      username: "owner",
      newEmail: "attacker@evil.test",
      actor: "owner",
    });

    expect(sent().to).toBe("old@example.com");
    expect(sent().text).not.toContain("attacker@evil.test");
    expect(sent().text).toContain("a•••@•••.test");
    expect(sent().text).toContain("owner");
  });

  it("says the account did it itself when no administrator is named", async () => {
    await notifyAddressChanged({
      previousEmail: "old@example.com",
      username: "owner",
      newEmail: "new@example.com",
    });

    expect(sent().text).toContain("the account itself");
  });
});

describe("maskAddress", () => {
  it("keeps one letter and the last label, and gives up safely on nonsense", () => {
    expect(maskAddress("owner@corp.example.com")).toBe("o•••@•••.com");
    expect(maskAddress("admin@intranet")).toBe("a•••@•••.intranet");
    expect(maskAddress("not-an-address")).toBe("•••");
  });
});

describe("notifyCredentialCreated", () => {
  it("names what was created and what it can reach", async () => {
    await notifyCredentialCreated({
      email: "owner@example.com",
      username: "owner",
      kind: "token",
      name: "laptop cli",
      scope: "your whole account",
    });

    expect(sent().subject).toContain("API token");
    expect(sent().text).toContain("laptop cli");
    expect(sent().text).toContain("your whole account");
    expect(sent().text).toContain("https://app.example.com/settings/tokens");
  });

  it("still sends without a configured origin, minus the link", async () => {
    selfOrigin.mockReturnValue(null);

    await notifyCredentialCreated({
      email: "owner@example.com",
      username: "owner",
      kind: "oauth",
      name: "Claude",
      scope: "board BP",
    });

    expect(sent().subject).toContain("Claude");
    expect(sent().html).not.toContain("href=\"http");
  });
});
