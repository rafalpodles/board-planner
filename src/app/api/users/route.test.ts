import { describe, it, expect, vi, beforeEach } from "vitest";

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
  MIN_PASSWORD_LENGTH: 8,
  PASSWORD_COST_FACTOR: 4,
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
  getAuthUser.mockResolvedValue({ _id: "a1", role: "admin", username: "rafal" });
});

describe("the row an account's creation leaves", () => {
  it("names the account and the administrator who made it", async () => {
    await post({ ...VALID, username: "newcomer" });

    expect(logInstanceAudit).toHaveBeenCalledWith({
      action: "user_created",
      user: "a1",
      actorUsername: "rafal",
      target: "newcomer",
      detail: "a member",
    });
  });

  it("says so when the account is the instance's first, and names nobody", async () => {
    countDocuments.mockResolvedValue(0);
    getAuthUser.mockResolvedValue(null);

    await post({ ...VALID, username: "firstadmin" });

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

  it("accepts an ordinary name, and stores it trimmed and lower-cased", async () => {
    const res = await post({ ...VALID, username: "  Nowak  " });

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].username).toBe("nowak");
  });

  it("accepts the shape of a machine account this instance creates", async () => {
    const res = await post({ ...VALID, username: "worker-6a7309535eb49af333b85a04" });

    expect(res.status).toBe(201);
  });
});

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

  it("accepts a name an allowlist would have refused, and stores it trimmed", async () => {
    const res = await post({
      username: "nowak",
      password: "password123",
      fullName: "  Rafał Podleś-O'Brien  ",
    });

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].fullName).toBe("Rafał Podleś-O'Brien");
  });
});
