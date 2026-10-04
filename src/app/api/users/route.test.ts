import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isValidUsername } from "@/lib/identifiers";

const create = vi.fn();
const countDocuments = vi.fn();
const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const find = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
const revokePendingInvitationsFor = vi.fn();
vi.mock("@/lib/invitations", () => ({ revokePendingInvitationsFor }));
type Listed = { _id: string; username: string; lastSignInAt?: Date | null };
let listed: Listed[] = [];
let withPassword: string[] = [];
let identities: { user: string; provider: string }[] = [];
const identityFind = vi.fn();
let sessionUse: { _id: string; lastUsedAt: Date }[] = [];
const doc = (fields: Listed) => ({ ...fields, toJSON: () => ({ ...fields }) });
vi.mock("@/models/user", () => ({
  User: {
    create: (...a: unknown[]) => create(...a),
    countDocuments: () => countDocuments(),
    find: (...a: unknown[]) => {
      find(...a);
      return {
        sort: async () => listed.map(doc),
        select: () => ({ lean: async () => withPassword.map((_id) => ({ _id })) }),
      };
    },
  },
}));
vi.mock("@/models/identity", () => ({
  Identity: {
    find: (filter: unknown) => {
      identityFind(filter);
      return { select: () => ({ sort: () => ({ lean: async () => identities }) }) };
    },
  },
}));
vi.mock("@/models/session", () => ({ Session: { aggregate: async () => sessionUse } }));
vi.mock("@/lib/oidc/providers", () => ({
  liveIdentityFilter: () => ({ live: "only" }),
  providerById: (id: string) => (id === "oidc" ? { label: "Acme SSO" } : id === "github" ? { label: "GitHub" } : null),
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: (...a: unknown[]) => getAuthUser(...a),
  getClientIp: () => "203.0.113.9",
  MIN_PASSWORD_LENGTH: 8,
  PASSWORD_COST_FACTOR: 4,
}));
const isRateLimited = vi.fn();
const recordFailedAttempt = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  anonymousMultiplier: (_ip: unknown, n: number) => n,
  isRateLimited: (...a: unknown[]) => isRateLimited(...a),
  recordFailedAttempt: (...a: unknown[]) => recordFailedAttempt(...a),
  sourceKey: (ip: string, scope: string) => `${scope}:${ip}`,
}));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/session", () => ({
  ProvenanceError: class ProvenanceError extends Error {},
  provenanceRefusal: () => null,
}));
vi.mock("@/lib/middleware", () => ({
  withAdmin: (h: (r: Request, c: unknown) => unknown) => (r: Request) => h(r, { user: { _id: "a1" } }),
}));

const nameOrganisation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  nameOrganisation,
}));

const { GET, POST } = await import("@/app/api/users/route");

const post = (body: unknown) =>
  POST(new Request("http://x/api/users", { method: "POST", body: JSON.stringify(body) }));

const VALID = { password: "password123", fullName: "Somebody" };

beforeEach(() => {
  create.mockReset();
  nameOrganisation.mockReset();
  revokePendingInvitationsFor.mockReset();
  logInstanceAudit.mockReset();
  create.mockResolvedValue({ _id: "u1", username: "newcomer" });
  countDocuments.mockResolvedValue(5);
  getAuthUser.mockResolvedValue({ _id: "a1", role: "admin", username: "owner" });
  isRateLimited.mockReset().mockResolvedValue(false);
  recordFailedAttempt.mockReset();
  process.env.BOOTSTRAP_TOKEN = "operator-held-setup-code";
});

/**
 * BP-538. The log knew that somebody had changed their display name and not that the account
 * existed. `target` is the username rather than a reference, because this row has to still name
 * them once the account is gone — which is the other row this ticket added.
 */
describe("the row an account's creation leaves", () => {
  it("names the account and the administrator who made it", async () => {
    await post({ ...VALID, username: "newcomer" });

    expect(logInstanceAudit).toHaveBeenCalledWith({
      action: "user_created",
      user: "a1",
      actorUsername: "owner",
      target: "newcomer",
      detail: "a member",
    });
  });

  // The first account on an instance is made by whoever reaches the login screen, so there is no
  // actor to name — and the row has to say which case it was, because this one is an administrator
  it("says so when the account is the instance's first, and names nobody", async () => {
    countDocuments.mockResolvedValue(0);
    getAuthUser.mockResolvedValue(null);

    await post({ ...VALID, username: "firstadmin", setupCode: "operator-held-setup-code" });

    expect(logInstanceAudit).toHaveBeenCalledWith({
      action: "user_created",
      user: null,
      actorUsername: "",
      target: "newcomer",
      detail: "the first account on this instance, made an administrator",
    });
  });

  it("records nothing when the account was refused", async () => {
    create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000, keyPattern: { username: 1 } }));

    const res = await post({ ...VALID, username: "taken", email: "ada@example.com" });

    expect(res.status).toBe(409);
    expect(logInstanceAudit).not.toHaveBeenCalled();
    // No account holds the address, so an invitation to it must survive the refusal
    expect(revokePendingInvitationsFor).not.toHaveBeenCalled();
  });
});

/**
 * A username reaches a notification title and from there the markup of a Slack or Discord
 * message, where `@everyone` pings a room and `>` and `#` change what the reader is looking at
 * (BP-401). The rule is at the source because escaping at each sink kept missing one.
 */
describe("the username an account may be given", () => {
  it.each([
    ["a mass mention", "@everyone"],
    ["a Slack link closer", "a>b"],
    ["a space", "a b"],
    ["a newline", "a\nb"],
    ["one character", "a"],
    ["something far too long", "a".repeat(33)],
  ])("refuses %s, and creates nothing", async (_label, username) => {
    const res = await post({ ...VALID, username });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  // Without this the refusals above would pass on a route that refuses everything
  it("accepts an ordinary name, and stores it trimmed and lower-cased", async () => {
    const res = await post({ ...VALID, username: "  Nowak  " });

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].username).toBe("nowak");
  });

  // The pattern must still fit what enrolment mints; enrolment upserts directly, not through here
  it("keeps the shape of a machine account inside the username rule", () => {
    expect(isValidUsername("worker-6a7309535eb49af333b85a04")).toBe(true);
  });

  // BP-348: a person holding one of these would be taken for the identity the instance mints
  it.each([["pm"], ["worker-6a7309535eb49af333b85a04"]])(
    "refuses to create a person under the reserved name %s",
    async (username) => {
      const res = await post({ ...VALID, username });

      expect(res.status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    }
  );

  it("still lets a person be called something that merely starts like one", async () => {
    const res = await post({ ...VALID, username: "worker-bee" });

    expect(res.status).toBe(201);
  });
});

/**
 * The same rule, on the other half of the field's life. This route used to check `fullName` for
 * truthiness only, so a name of nothing but spaces reached the schema, was trimmed to "" there,
 * and came back as a `required` ValidationError — a 400 delivered as a 500 (BP-410).
 */
describe("the display name an account may be given", () => {
  it.each([
    ["a name of nothing but spaces", "   "],
    ["no name at all", ""],
    ["a newline", "Some\nbody"],
    ["a Unicode line separator", "Some\u2028body"],
    ["an escape character", "Some\u001bbody"],
    ["something far too long", "a".repeat(81)],
  ])("refuses %s with a 400, and creates nothing", async (_label, fullName) => {
    const res = await post({ username: "nowak", password: "password123", fullName });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  // Without this the refusals above would pass on a route that refuses everything
  it("accepts a name an allowlist would have refused, and stores it trimmed", async () => {
    const res = await post({
      username: "nowak",
      password: "password123",
      fullName: "  Owner Name-O'Brien  ",
    });

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].fullName).toBe("Owner Name-O'Brien");
  });
});

// BP-325: an instance is reachable before its operator registers, and the first account is an admin
describe("claiming an instance nobody has claimed", () => {
  beforeEach(() => {
    countDocuments.mockResolvedValue(0);
    getAuthUser.mockResolvedValue(null);
  });

  it.each([
    ["no setup code", {}],
    ["the wrong one", { setupCode: "a-guess" }],
  ])("refuses a first account with %s, and counts the attempt", async (_label, extra) => {
    const res = await post({ ...VALID, username: "firstadmin", ...extra });

    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(recordFailedAttempt).toHaveBeenCalledWith("bootstrap:203.0.113.9");
  });

  it("names the organisation after the first account, trimmed, when the operator gives a name", async () => {
    countDocuments.mockResolvedValue(0);
    getAuthUser.mockResolvedValue(null);

    const res = await post({ ...VALID, username: "firstadmin", setupCode: "operator-held-setup-code", organisation: "  Rafał-org  " });

    expect(res.status).toBe(201);
    expect(nameOrganisation).toHaveBeenCalledWith("Rafał-org");
  });

  it("leaves the organisation as it is when the first account gives no name, or a blank one", async () => {
    countDocuments.mockResolvedValue(0);
    getAuthUser.mockResolvedValue(null);

    await post({ ...VALID, username: "firstadmin", setupCode: "operator-held-setup-code" });
    await post({ ...VALID, username: "secondtry", setupCode: "operator-held-setup-code", organisation: "   " });

    expect(nameOrganisation).not.toHaveBeenCalled();
  });

  it("refuses an organisation name over the limit before making any account", async () => {
    countDocuments.mockResolvedValue(0);
    getAuthUser.mockResolvedValue(null);

    const res = await post({ ...VALID, username: "firstadmin", setupCode: "operator-held-setup-code", organisation: "x".repeat(81) });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores an organisation name once the instance is claimed: an administrator adding a member cannot rename it", async () => {
    await post({ ...VALID, username: "someone", organisation: "Hijacked" });

    expect(nameOrganisation).not.toHaveBeenCalled();
  });

  it("creates the administrator when the operator's code is given", async () => {
    const res = await post({ ...VALID, username: "firstadmin", setupCode: "operator-held-setup-code" });

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].role).toBe("admin");
  });

  it("stops listening to guesses once the source is throttled", async () => {
    isRateLimited.mockResolvedValue(true);

    const res = await post({ ...VALID, username: "firstadmin", setupCode: "a-guess" });

    expect(res.status).toBe(429);
    expect(create).not.toHaveBeenCalled();
  });

  // An operator-chosen token can be guessable, so a throttled source cannot keep trying it
  it("throttles a configured token before comparing it", async () => {
    isRateLimited.mockResolvedValue(true);

    const res = await post({ ...VALID, username: "firstadmin", setupCode: "operator-held-setup-code" });

    expect(res.status).toBe(429);
    expect(create).not.toHaveBeenCalled();
  });

  // A generated code is 128 random bits; a stranger filling the shared bucket must not lock it out
  it("lets a generated code through a throttled source", async () => {
    delete process.env.BOOTSTRAP_TOKEN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { setupCode } = await import("@/lib/setup-code");
      isRateLimited.mockResolvedValue(true);

      const res = await post({ ...VALID, username: "firstadmin", setupCode: setupCode() });

      expect(res.status).toBe(201);
    } finally {
      warn.mockRestore();
    }
  });

  it("never asks an existing instance's admin for a setup code", async () => {
    countDocuments.mockResolvedValue(5);
    getAuthUser.mockResolvedValue({ _id: "a1", role: "admin", username: "owner" });

    const res = await post({ ...VALID, username: "newcomer" });

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].role).toBe("member");
  });
});

describe("which accounts the list returns", () => {
  const list = (query = "") =>
    GET(new Request(`http://x/api/users${query}`), { params: Promise.resolve({}) });

  beforeEach(() => {
    find.mockReset();
    listed = [];
    withPassword = [];
    identities = [];
    sessionUse = [];
  });

  // BP-831. Three reads for the whole list, never one per person
  it("names how each account signs in: a password, then each linked provider", async () => {
    listed = [
      { _id: "u1", username: "ada" },
      { _id: "u2", username: "grace" },
      { _id: "u3", username: "linus" },
    ];
    withPassword = ["u1", "u3"];
    identities = [
      { user: "u2", provider: "oidc" },
      { user: "u2", provider: "github" },
      { user: "u3", provider: "oidc" },
    ];

    const body = await (await list()).json();

    expect(body.map((u: { username: string; signInMethods: string[] }) => [u.username, u.signInMethods])).toEqual([
      ["ada", ["Password"]],
      ["grace", ["Acme SSO", "GitHub"]],
      ["linus", ["Password", "Acme SSO"]],
    ]);
  });

  // BP-842. A link from a provider's former issuer is no way in
  it("reads only the links a configured provider still signs in through", async () => {
    listed = [{ _id: "u1", username: "ada" }];

    await list();

    expect(identityFind).toHaveBeenCalledWith({ user: { $in: ["u1"] }, live: "only" });
  });

  it("counts no link to a provider the instance no longer has as a way in", async () => {
    listed = [{ _id: "u1", username: "ada" }];
    identities = [
      { user: "u1", provider: "google" },
      { user: "u1", provider: "oidc" },
    ];

    const body = await (await list()).json();

    expect(body[0].signInMethods).toEqual(["Acme SSO"]);
  });

  it("dates activity by the later of the last sign-in and a session used since", async () => {
    const day = 86_400_000;
    const now = Date.now();
    listed = [
      { _id: "u1", username: "ada", lastSignInAt: new Date(now - 29 * day) },
      { _id: "u2", username: "grace", lastSignInAt: new Date(now - 2 * day) },
      { _id: "u3", username: "linus", lastSignInAt: null },
      { _id: "u4", username: "ken", lastSignInAt: null },
    ];
    sessionUse = [
      { _id: "u1", lastUsedAt: new Date(now - day) },
      { _id: "u2", lastUsedAt: new Date(now - 5 * day) },
      { _id: "u3", lastUsedAt: new Date(now - 3 * day) },
    ];

    const body = await (await list()).json();

    expect(body.map((u: { lastActiveAt: string | null }) => u.lastActiveAt)).toEqual([
      new Date(now - day).toISOString(),
      new Date(now - 2 * day).toISOString(),
      new Date(now - 3 * day).toISOString(),
      null,
    ]);
  });

  it("counts no password as a way in once password sign-in is off", async () => {
    listed = [{ _id: "u1", username: "ada" }];
    withPassword = ["u1"];
    process.env.PASSWORD_SIGN_IN = "off";
    try {
      const body = await (await list()).json();
      expect(body[0].signInMethods).toEqual([]);
    } finally {
      delete process.env.PASSWORD_SIGN_IN;
    }
  });

  it("leaves machine accounts out by default", async () => {
    await list();
    expect(find).toHaveBeenCalledWith({ kind: { $ne: "machine" } });
  });

  it("includes them when asked for machines", async () => {
    await list("?include=machines");
    expect(find).toHaveBeenCalledWith({});
  });

  it("does not read any other value as the opt-in", async () => {
    await list("?include=machine");
    expect(find).toHaveBeenCalledWith({ kind: { $ne: "machine" } });
  });
});

describe("an account taking an address", () => {
  // BP-826: a pending invitation to that address would otherwise come back to life the day this
  // account is deleted or moves away
  it("withdraws any pending invitation for it", async () => {
    const res = await post({ ...VALID, username: "newcomer", email: " Ada@Example.com " });

    expect(res.status).toBe(201);
    expect(revokePendingInvitationsFor).toHaveBeenCalledWith("ada@example.com");
  });
});

describe("with password sign-in off (BP-830)", () => {
  beforeEach(() => {
    process.env.PASSWORD_SIGN_IN = "off";
  });
  afterEach(() => {
    delete process.env.PASSWORD_SIGN_IN;
  });
  it("makes no account with a password, first or not", async () => {
    expect((await post({ ...VALID, username: "first", email: "first@example.com", setupCode: "x" })).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});
