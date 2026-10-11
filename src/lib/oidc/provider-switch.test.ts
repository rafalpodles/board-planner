import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Types } from "mongoose";

vi.mock("@/lib/organisation", () => ({ getOrganisation: vi.fn() }));
const ssoEnforced = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/oidc/providers", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/oidc/providers")>()), ssoEnforced }));

const { isSwitchable, membersOnlyThrough, providerSwitchView } = await import("./provider-switch");

const ENV_KEYS = ["ORGANISATION_DOMAIN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "PASSWORD_SIGN_IN", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"];
const organisation = new Types.ObjectId();
const [u1, u2, u3] = [1, 2, 3].map(() => new Types.ObjectId());

interface Fake {
  settings?: Record<string, unknown>;
  linked: { user: Types.ObjectId }[];
  users: { _id: Types.ObjectId }[];
  stillIn?: { user: Types.ObjectId }[];
}

function fakeDb({ settings = {}, linked, users, stillIn = [] }: Fake) {
  const identityFind = vi.fn();
  identityFind.mockReturnValueOnce({ select: () => ({ lean: async () => linked }) });
  identityFind.mockReturnValueOnce({ select: () => ({ lean: async () => stillIn }) });
  const userFind = vi.fn(() => ({ select: () => ({ lean: async () => users }) }));
  const db = {
    organisation,
    Settings: { findOne: () => ({ lean: async () => settings }) },
    Identity: { find: identityFind },
    User: { find: userFind },
  };
  return { db: db as never, identityFind, userFind };
}

beforeEach(() => {
  ssoEnforced.mockResolvedValue(false);
  Object.assign(process.env, { ORGANISATION_DOMAIN: "board.example", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs", GITHUB_OAUTH_CLIENT_ID: "gh", GITHUB_OAUTH_CLIENT_SECRET: "ghs" });
});
afterEach(() => ENV_KEYS.forEach((key) => delete process.env[key]));

describe("what an administrator may switch (BP-1027)", () => {
  it("is Google and GitHub where the operator set them up, and nothing else", () => {
    process.env.OIDC_ISSUER = "https://shared.example";
    process.env.OIDC_CLIENT_ID = "shared";
    process.env.OIDC_CLIENT_SECRET = "shared-secret";

    expect(["google", "github", "oidc", "gitlab", undefined].map(isSwitchable)).toEqual([true, true, false, false, false]);
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    expect(isSwitchable("github")).toBe(false);
  });

  it("is shown with each provider on, until it is switched off", async () => {
    const { db } = fakeDb({ linked: [], users: [], settings: { disabledProviders: ["github"] } });

    expect((await providerSwitchView(db)).providers).toEqual([
      { id: "google", label: "Google", enabled: true },
      { id: "github", label: "GitHub", enabled: false },
    ]);
  });
});

describe("the members left with no way in by switching a provider off (BP-1027)", () => {
  it("counts a member linked to it, active, with no password and no other way in", async () => {
    const { db } = fakeDb({ linked: [{ user: u1 }, { user: u2 }], users: [{ _id: u1 }, { _id: u2 }], stillIn: [{ user: u2 }] });

    expect(await membersOnlyThrough(db, "google")).toBe(1);
  });

  it("is nobody when nobody linked it, asking nothing more of the database", async () => {
    const { db, userFind } = fakeDb({ linked: [], users: [] });

    expect(await membersOnlyThrough(db, "google")).toBe(0);
    expect(userFind).not.toHaveBeenCalled();
  });

  it("looks only at active people, never at a machine, and at those with no password where passwords sign in", async () => {
    const { db, userFind } = fakeDb({ linked: [{ user: u1 }, { user: u3 }], users: [{ _id: u1 }] });

    await membersOnlyThrough(db, "google");

    expect(userFind).toHaveBeenCalledWith({
      _id: { $in: [String(u1), String(u3)] },
      deactivatedAt: null,
      kind: { $ne: "machine" },
      $or: [{ password: { $exists: false } }, { password: null }, { password: "" }],
    });
  });

  it("counts every linked member where passwords are off, since a provider is then the only way in", async () => {
    process.env.PASSWORD_SIGN_IN = "off";
    const { db, userFind } = fakeDb({ linked: [{ user: u1 }], users: [{ _id: u1 }] });

    expect(await membersOnlyThrough(db, "google")).toBe(1);
    expect(userFind.mock.calls[0]).toEqual([expect.not.objectContaining({ $or: expect.anything() })]);
  });

  it("does not count a member who also has a live link to a provider that stays on", async () => {
    const { db, identityFind } = fakeDb({ linked: [{ user: u1 }], users: [{ _id: u1 }], stillIn: [{ user: u1 }] });

    expect(await membersOnlyThrough(db, "google")).toBe(0);
    const second = identityFind.mock.calls[1][0] as { $and?: unknown; $or: { provider: string }[] };
    expect(second.$or.map((clause) => clause.provider)).toEqual(["github"]);
  });

  it("counts a member whose only other link is to a provider that is off as well", async () => {
    const { db, identityFind } = fakeDb({ settings: { disabledProviders: ["github"] }, linked: [{ user: u1 }], users: [{ _id: u1 }] });

    expect(await membersOnlyThrough(db, "google")).toBe(1);
    expect((identityFind.mock.calls[1][0] as { $or: unknown[] }).$or).toEqual([{ _id: null }]);
  });

  it("is nobody for a provider the operator did not set up", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    const { db, identityFind } = fakeDb({ linked: [{ user: u1 }], users: [{ _id: u1 }] });

    expect(await membersOnlyThrough(db, "github")).toBe(0);
    expect(identityFind).not.toHaveBeenCalled();
  });

  it("is nobody while single sign-on is required, since Google and GitHub are closed already", async () => {
    ssoEnforced.mockResolvedValue(true);
    const { db, identityFind } = fakeDb({ linked: [{ user: u1 }], users: [{ _id: u1 }] });

    expect(await membersOnlyThrough(db, "google")).toBe(0);
    expect(identityFind).not.toHaveBeenCalled();
  });

  it("asks for this provider's links of the issuer it signs as, then for the remaining providers' links of only those members", async () => {
    const { db, identityFind } = fakeDb({ linked: [{ user: u1 }, { user: u1 }], users: [{ _id: u1 }] });

    expect(await membersOnlyThrough(db, "google")).toBe(1);

    const [first, second] = identityFind.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(first.provider).toBe("google");
    expect((first.$or as { provider: string }[]).map((clause) => clause.provider)).toEqual(["google"]);
    expect(second.user).toEqual({ $in: [u1] });
    expect((second.$or as { provider: string }[]).map((clause) => clause.provider)).toEqual(["github"]);
  });

  it("counts a member with two links to the same provider once", async () => {
    const { db, userFind } = fakeDb({ linked: [{ user: u1 }, { user: u1 }], users: [{ _id: u1 }] });

    expect(await membersOnlyThrough(db, "google")).toBe(1);
    expect(userFind).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [String(u1)] } }));
  });
});
