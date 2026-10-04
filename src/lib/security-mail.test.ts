import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const sendEmail = vi.fn().mockResolvedValue(true);
const isEmailConfigured = vi.fn(() => true);
const selfOrigin = vi.fn<() => string | null>(() => "https://app.example.com");

vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  isEmailConfigured: () => isEmailConfigured(),
}));
vi.mock("@/lib/session", () => ({ selfOrigin: () => selfOrigin() }));
const tenantSlug = vi.fn<() => string | undefined>(() => undefined);
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/tenant", () => ({
  Tenant: { findById: () => ({ select: () => ({ lean: async () => ({ slug: tenantSlug() }) }) }) },
}));

const { notifyPasswordChanged, notifyAddressChanged, notifyCredentialCreated, notifyIdentityLinked, maskAddress } =
  await import("@/lib/security-mail");
const { forgetTenantSlugs } = await import("@/lib/tenant-host");

const TENANT = new Types.ObjectId();

const sent = () => sendEmail.mock.calls.at(-1)?.[0] as { to: string; subject: string; html: string; text: string };

beforeEach(() => {
  sendEmail.mockClear();
  isEmailConfigured.mockReturnValue(true);
  selfOrigin.mockReturnValue("https://app.example.com");
});

describe("notifyPasswordChanged", () => {
  it("warns hard when a reset link did it, because that is the takeover case", async () => {
    await notifyPasswordChanged({
      tenant: TENANT,
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
      tenant: TENANT,
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
    await notifyPasswordChanged({ tenant: TENANT, email: "", username: "owner", how: "admin" });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("swallows a mail server having a bad afternoon", async () => {
    sendEmail.mockRejectedValueOnce(new Error("smtp is down"));

    await expect(
      notifyPasswordChanged({ tenant: TENANT, email: "owner@example.com", username: "owner", how: "admin" })
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
      tenant: TENANT,
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
      tenant: TENANT,
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

describe("notifyIdentityLinked", () => {
  const LINKED = { tenant: TENANT, email: "owner@example.com", username: "owner", provider: "Acme", providerEmail: "o@acme.example" };

  it("tells the owner to change the password, which unlinks it", async () => {
    await notifyIdentityLinked(LINKED);

    expect(sent().text).toContain("change your password");
  });

  // BP-830. There is no password to change on an instance that turned them off
  it("points somewhere that works when password sign-in is off", async () => {
    process.env.PASSWORD_SIGN_IN = "off";
    try {
      await notifyIdentityLinked(LINKED);
    } finally {
      delete process.env.PASSWORD_SIGN_IN;
    }

    expect(sent().text).not.toContain("change your password");
    expect(sent().text).toContain("ask an administrator to sign you out everywhere");
  });
});

describe("with TENANT_DOMAIN set, every button leads to the account's own tenant (BP-666)", () => {
  beforeEach(() => {
    process.env.TENANT_DOMAIN = "board-planner.com";
    tenantSlug.mockReturnValue("acme");
    forgetTenantSlugs();
  });

  afterEach(() => {
    delete process.env.TENANT_DOMAIN;
  });

  it("signs in, reviews tokens and reviews providers on the tenant's subdomain", async () => {
    await notifyPasswordChanged({ tenant: TENANT, email: "owner@example.com", username: "owner", how: "admin" });
    expect(sent().html).toContain("https://acme.board-planner.com/login");

    await notifyCredentialCreated({ tenant: TENANT, email: "owner@example.com", username: "owner", kind: "token", name: "ci", scope: "BP" });
    expect(sent().html).toContain("https://acme.board-planner.com/settings/tokens");

    await notifyIdentityLinked({ tenant: TENANT, email: "owner@example.com", username: "owner", provider: "Acme", providerEmail: "o@acme.example" });
    expect(sent().html).toContain("https://acme.board-planner.com/settings/security");
    expect(JSON.stringify(sendEmail.mock.calls)).not.toContain("app.example.com");
  });

  it("leaves the button out for a tenant with no address, rather than linking to another", async () => {
    tenantSlug.mockReturnValue(undefined);

    await notifyPasswordChanged({ tenant: TENANT, email: "owner@example.com", username: "owner", how: "admin" });

    expect(sent().html).not.toContain("href=\"http");
  });
});
