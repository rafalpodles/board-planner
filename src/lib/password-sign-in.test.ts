import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

let admins: { _id: string; emailVerifiedAt?: Date | null }[] = [];
let identities: { user: string; provider: string }[] = [];
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
    exists: async (filter: { user: { $in: string[] }; provider: { $in: string[] } }) =>
      identities.some((i) => filter.user.$in.includes(i.user) && filter.provider.$in.includes(i.provider)) ? { _id: "i" } : null,
  },
}));

const { adminsLockedOut, assertSignInConfig, passwordSignInEnabled } = await import("./password-sign-in");

const KEYS = [
  "PASSWORD_SIGN_IN",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_BASE_URL",
];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

const withOidc = () =>
  Object.assign(process.env, { OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s" });

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

    expect(await adminsLockedOut()).toBeNull();
  });

  it("names the lockout when no active administrator has a provider or a proven address", async () => {
    withOidc();

    expect(await adminsLockedOut()).toMatch(/no active administrator can sign in through a configured provider/);
    expect(userFind).toHaveBeenCalledWith({ role: "admin", deactivatedAt: null, kind: { $ne: "machine" } });
  });

  it("lets an administrator in by a proven address an OpenID Connect provider links by", async () => {
    withOidc();
    admins = [{ _id: "a1", emailVerifiedAt: new Date() }];

    expect(await adminsLockedOut()).toBeNull();
  });

  it("does not count a proven address when only GitHub, which never links by address, is set up", async () => {
    withGitHub();
    admins = [{ _id: "a1", emailVerifiedAt: new Date() }];

    expect(await adminsLockedOut()).not.toBeNull();
  });

  it("lets an administrator in through a provider linked to them that is still set up", async () => {
    withGitHub();
    identities = [{ user: "a1", provider: "github" }];

    expect(await adminsLockedOut()).toBeNull();
  });

  it("does not count a link to a provider no longer set up", async () => {
    withOidc();
    identities = [{ user: "a1", provider: "google" }];

    expect(await adminsLockedOut()).not.toBeNull();
  });

  it("does not count a link belonging to somebody who is not an administrator", async () => {
    withOidc();
    identities = [{ user: "m1", provider: "oidc" }];

    expect(await adminsLockedOut()).not.toBeNull();
  });

  it("has nobody to lock out on an instance with no administrator yet", async () => {
    withOidc();
    admins = [];

    expect(await adminsLockedOut()).toBeNull();
  });
});
