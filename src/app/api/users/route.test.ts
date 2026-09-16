import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidUsername } from "@/lib/identifiers";

const create = vi.fn();
const countDocuments = vi.fn();
const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({
  User: {
    create: (...a: unknown[]) => create(...a),
    countDocuments: () => countDocuments(),
    find: () => ({ sort: async () => [] }),
  },
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

const { POST } = await import("@/app/api/users/route");

const post = (body: unknown) =>
  POST(new Request("http://x/api/users", { method: "POST", body: JSON.stringify(body) }));

const VALID = { password: "password123", fullName: "Somebody" };

beforeEach(() => {
  create.mockReset();
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

    const res = await post({ ...VALID, username: "taken" });

    expect(res.status).toBe(409);
    expect(logInstanceAudit).not.toHaveBeenCalled();
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

  // The anonymous bucket is shared, so a stranger could otherwise fill it and lock the operator out
  it("still lets the operator's own code through a throttled source", async () => {
    isRateLimited.mockResolvedValue(true);

    const res = await post({ ...VALID, username: "firstadmin", setupCode: "operator-held-setup-code" });

    expect(res.status).toBe(201);
  });

  it("never asks an existing instance's admin for a setup code", async () => {
    countDocuments.mockResolvedValue(5);
    getAuthUser.mockResolvedValue({ _id: "a1", role: "admin", username: "owner" });

    const res = await post({ ...VALID, username: "newcomer" });

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].role).toBe("member");
  });
});
