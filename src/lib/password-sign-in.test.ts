import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

let admins: { _id: string; email?: string; emailVerifiedAt?: Date | null }[] = [];
let identities: { user: string; provider: string; issuer: string }[] = [];
const userFind = vi.fn();
vi.mock("@/models/user", () => ({
  User: {
    find: (filter: unknown) => {
      userFind(filter);
      return { select: () => ({ lean: async () => admins }) };
    },
  },
}));
vi.mock("@/models/identity", () => ({
  Identity: {
    // As Mongo reads `{$and: [{user: {$in}}, {$or: [{provider, issuer: {$in}}]}]}`
    exists: async (filter: { $and: [{ user: { $in: string[] } }, { $or: Record<string, unknown>[] }] }) => {
      const [{ user }, { $or }] = filter.$and;
      const live = (i: (typeof identities)[number]) =>
        $or.some(
          (c) => c.provider === i.provider && ((c.issuer as { $in: string[] } | undefined)?.$in ?? []).includes(i.issuer)
        );
      return identities.some((i) => user.$in.includes(i.user) && live(i)) ? { _id: "i" } : null;
    },
  },
}));

const { adminsLockedOut, assertSignInConfig, passwordSignInEnabled } = await import("./password-sign-in");
const { scopedToDefaultTenant } = await import("@/lib/db-scope");
const { DEFAULT_TENANT_ID } = await import("@/lib/tenant-field");

const KEYS = [
  "PASSWORD_SIGN_IN",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_BASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OIDC_RELAY_ORIGIN",
];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

const withOidc = () =>
  Object.assign(process.env, { OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s" });

describe("OIDC_RELAY_ORIGIN at startup", () => {
  it("stops the app on a relay that is not a bare origin", () => {
    process.env.OIDC_RELAY_ORIGIN = "https://login.example.com/sso";

    expect(() => assertSignInConfig()).toThrow(/OIDC_RELAY_ORIGIN/);
  });

  it("starts with a relay that is one", () => {
    process.env.OIDC_RELAY_ORIGIN = "https://login.example.com";

    expect(() => assertSignInConfig()).not.toThrow();
  });
});

describe("PASSWORD_SIGN_IN", () => {
  it.each([[undefined], ["on"], ["ON"], [" on "]])("keeps passwords for %j", (value) => {
    if (value !== undefined) process.env.PASSWORD_SIGN_IN = value;

    expect(passwordSignInEnabled()).toBe(true);
    expect(() => assertSignInConfig()).not.toThrow();
  });

  it("turns them off with a provider to sign in with", () => {
    process.env.PASSWORD_SIGN_IN = "Off";
    withOidc();

    expect(passwordSignInEnabled()).toBe(false);
    expect(() => assertSignInConfig()).not.toThrow();
  });

  // Nobody could sign in to an instance with passwords off and no provider
  it("refuses to start off with no provider configured", () => {
    process.env.PASSWORD_SIGN_IN = "off";

    expect(() => assertSignInConfig()).toThrow(/needs a sign-in provider/);
  });

  it("refuses to start on a value that is neither on nor off", () => {
    process.env.PASSWORD_SIGN_IN = "false";
    withOidc();

    expect(() => assertSignInConfig()).toThrow(/must be "on" or "off"/);
  });
});

// BP-840. Passwords off where no administrator can come back through a provider is an instance
// nobody can administer once their sessions lapse
describe("whether passwords off would lock every administrator out", () => {
  const withGitHub = () =>
    Object.assign(process.env, {
      GITHUB_OAUTH_CLIENT_ID: "c",
      GITHUB_OAUTH_CLIENT_SECRET: "s",
      GITHUB_OAUTH_BASE_URL: "https://github.com",
    });

  beforeEach(() => {
    admins = [{ _id: "a1", emailVerifiedAt: null }];
    identities = [];
    userFind.mockClear();
    process.env.PASSWORD_SIGN_IN = "off";
  });

  it("is no concern while passwords are on", async () => {
    process.env.PASSWORD_SIGN_IN = "on";
    withOidc();

    expect(await adminsLockedOut(scopedToDefaultTenant())).toBeNull();
  });

  it("names the lockout when no active administrator has a provider or a proven address", async () => {
    withOidc();

    expect(await adminsLockedOut(scopedToDefaultTenant())).toMatch(/no active administrator can sign in through a configured provider/);
    expect(userFind).toHaveBeenCalledWith({ role: "admin", deactivatedAt: null, kind: { $ne: "machine" }, tenant: DEFAULT_TENANT_ID });
  });

  it("lets an administrator in by a proven address an OpenID Connect provider links by", async () => {
    withOidc();
    admins = [{ _id: "a1", emailVerifiedAt: new Date() }];

    expect(await adminsLockedOut(scopedToDefaultTenant())).toBeNull();
  });

  it("does not count a proven address when only GitHub, which never links by address, is set up", async () => {
    withGitHub();
    admins = [{ _id: "a1", emailVerifiedAt: new Date() }];

    expect(await adminsLockedOut(scopedToDefaultTenant())).not.toBeNull();
  });

  // Google vouches only for its own domains; a Workspace's cannot be told from here
  it("counts a proven address under Google only when it is a Gmail one", async () => {
    Object.assign(process.env, { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs" });
    admins = [{ _id: "a1", email: "admin@corp.example", emailVerifiedAt: new Date() }];
    expect(await adminsLockedOut(scopedToDefaultTenant())).not.toBeNull();

    admins = [{ _id: "a1", email: "admin@gmail.com", emailVerifiedAt: new Date() }];
    expect(await adminsLockedOut(scopedToDefaultTenant())).toBeNull();
  });

  it("lets an administrator in through a provider linked to them that is still set up", async () => {
    withGitHub();
    identities = [{ user: "a1", provider: "github", issuer: "https://github.com" }];

    expect(await adminsLockedOut(scopedToDefaultTenant())).toBeNull();
  });

  // BP-842's rule: a link made while the provider signed as another issuer is no way in
  it("does not count a link from the provider's former issuer", async () => {
    withOidc();
    identities = [{ user: "a1", provider: "oidc", issuer: "https://former-issuer.example" }];

    expect(await adminsLockedOut(scopedToDefaultTenant())).not.toBeNull();
  });

  it("does not count a link to a provider no longer set up", async () => {
    withOidc();
    identities = [{ user: "a1", provider: "google", issuer: "https://accounts.google.com" }];

    expect(await adminsLockedOut(scopedToDefaultTenant())).not.toBeNull();
  });

  it("does not count a link belonging to somebody who is not an administrator", async () => {
    withOidc();
    identities = [{ user: "m1", provider: "oidc", issuer: "https://id.example.com" }];

    expect(await adminsLockedOut(scopedToDefaultTenant())).not.toBeNull();
  });

  it("has nobody to lock out on an instance with no administrator yet", async () => {
    withOidc();
    admins = [];

    expect(await adminsLockedOut(scopedToDefaultTenant())).toBeNull();
  });
});
