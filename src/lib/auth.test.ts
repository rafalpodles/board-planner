import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const userFindById = vi.fn();
const apiTokenFind = vi.fn();
const apiTokenFindByIdAndUpdate = vi.fn();
const oauthTokenFindOne = vi.fn();
const sessionFindOne = vi.fn();
const sessionUpdateOne = vi.fn();
const bcryptCompare = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { compare: bcryptCompare } }));
vi.mock("@/models/user", () => ({ User: { findById: userFindById, findOne: vi.fn() } }));
vi.mock("@/models/apiToken", () => ({
  ApiToken: { find: apiTokenFind, findByIdAndUpdate: apiTokenFindByIdAndUpdate },
}));
vi.mock("@/models/oauthToken", () => ({ OAuthToken: { findOne: oauthTokenFindOne } }));
vi.mock("@/models/session", () => ({
  Session: { findOne: sessionFindOne, updateOne: sessionUpdateOne },
}));

const { getAuthUser } = await import("./auth");
const { ProvenanceError, SESSION_IDLE_TTL_MS } = await import("./session");
const { sha256 } = await import("./oauth");

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TOKEN = "cps_" + "a".repeat(64);
const MACHINE_TOKEN = "cpat_" + "b".repeat(64);

function user(overrides: Record<string, unknown> = {}) {
  return { _id: "u1", username: "rpo", role: "admin", ...overrides };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    _id: "s1",
    user: "u1",
    expiresAt: new Date(now + SESSION_IDLE_TTL_MS),
    absoluteExpiresAt: new Date(now + 90 * DAY_MS),
    ...overrides,
  };
}

function sessionFound(value: unknown) {
  sessionFindOne.mockReturnValue({ lean: () => Promise.resolve(value) });
}

function request(headers: Record<string, string>, method = "GET"): Request {
  return new Request("https://app.example.com/api/tasks", { method, headers });
}

function withCookie(value: string, extra: Record<string, string> = {}, method = "GET") {
  return request({ cookie: `__Host-bp_session=${value}`, ...extra }, method);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.COOKIE_ALLOW_INSECURE;
  delete process.env.APP_ORIGIN;
  sessionFound(null);
  sessionUpdateOne.mockResolvedValue({});
  apiTokenFind.mockReturnValue({ lean: () => Promise.resolve([]) });
  apiTokenFindByIdAndUpdate.mockReturnValue(Promise.resolve(null));
  oauthTokenFindOne.mockResolvedValue(null);
  userFindById.mockResolvedValue(user());
  bcryptCompare.mockResolvedValue(false);
});

afterEach(() => {
  delete process.env.COOKIE_ALLOW_INSECURE;
  delete process.env.APP_ORIGIN;
});

describe("getAuthUser — session cookie", () => {
  it("resolves a live session as a human credential and attaches the row id", async () => {
    sessionFound(sessionRow());

    const result = await getAuthUser(withCookie(SESSION_TOKEN));

    expect(result).toMatchObject({ username: "rpo" });
    expect(result?.viaMachineCredential).toBe(false);
    expect(result?.sessionId).toBe("s1");
  });

  it("looks the cookie up by sha256 and never stores or queries the raw value", async () => {
    sessionFound(sessionRow());

    await getAuthUser(withCookie(SESSION_TOKEN));

    expect(sessionFindOne).toHaveBeenCalledWith({ tokenHash: sha256(SESSION_TOKEN) });
  });

  it("is null when the cookie matches no row", async () => {
    expect(await getAuthUser(withCookie(SESSION_TOKEN))).toBeNull();
  });

  it("is null when the session's user no longer exists", async () => {
    sessionFound(sessionRow());
    userFindById.mockResolvedValue(null);

    expect(await getAuthUser(withCookie(SESSION_TOKEN))).toBeNull();
  });
});

describe("getAuthUser — machine credentials", () => {
  it("marks an OAuth access token as a machine credential", async () => {
    oauthTokenFindOne.mockResolvedValue({
      user: "u1",
      accessExpiresAt: new Date(Date.now() + DAY_MS),
      allowedProjects: [],
    });

    const result = await getAuthUser(
      request({ authorization: `Bearer ${MACHINE_TOKEN}` })
    );

    expect(result?.viaMachineCredential).toBe(true);
    expect(result?.sessionId).toBeUndefined();
  });

  it("marks an API token as a machine credential", async () => {
    const token = "cp_" + "c".repeat(64);
    apiTokenFind.mockReturnValue({
      lean: () => Promise.resolve([{ _id: "t1", user: "u1", tokenHash: "hashed", allowedProjects: [] }]),
    });
    bcryptCompare.mockResolvedValue(true);

    const result = await getAuthUser(request({ authorization: `Bearer ${token}` }));

    expect(result?.viaMachineCredential).toBe(true);
  });
});

describe("getAuthUser — Basic auth is gone", () => {
  it("rejects a Basic header instead of verifying the password it carries", async () => {
    const basic = Buffer.from("rpo:correct-horse").toString("base64");

    expect(await getAuthUser(request({ authorization: `Basic ${basic}` }))).toBeNull();
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  it("does not fall back to a password check when a Basic header accompanies a dead cookie", async () => {
    const basic = Buffer.from("rpo:correct-horse").toString("base64");

    const result = await getAuthUser(
      withCookie(SESSION_TOKEN, { authorization: `Basic ${basic}` })
    );

    expect(result).toBeNull();
    expect(bcryptCompare).not.toHaveBeenCalled();
  });
});

describe("getAuthUser — machine token planted in the session cookie", () => {
  it("refuses a cpat_ carried in the cookie: it is not in the Session collection", async () => {
    oauthTokenFindOne.mockResolvedValue({
      user: "u1",
      accessExpiresAt: new Date(Date.now() + DAY_MS),
      allowedProjects: [],
    });

    const result = await getAuthUser(withCookie(MACHINE_TOKEN));

    expect(result).toBeNull();
    expect(oauthTokenFindOne).not.toHaveBeenCalled();
  });

  it("refuses a cp_ carried in the cookie without consulting the API tokens", async () => {
    bcryptCompare.mockResolvedValue(true);
    apiTokenFind.mockReturnValue({
      lean: () => Promise.resolve([{ _id: "t1", user: "u1", tokenHash: "hashed", allowedProjects: [] }]),
    });

    const result = await getAuthUser(withCookie("cp_" + "c".repeat(64)));

    expect(result).toBeNull();
    expect(apiTokenFind).not.toHaveBeenCalled();
  });
});

describe("getAuthUser — provenance on the cookie branch", () => {
  it("passes a mutating same-origin request", async () => {
    sessionFound(sessionRow());

    const result = await getAuthUser(
      withCookie(SESSION_TOKEN, { "sec-fetch-site": "same-origin" }, "POST")
    );

    expect(result?.viaMachineCredential).toBe(false);
  });

  it("throws on a cross-site mutating request before the session is looked up", async () => {
    sessionFound(sessionRow());

    await expect(
      getAuthUser(withCookie(SESSION_TOKEN, { "sec-fetch-site": "cross-site" }, "POST"))
    ).rejects.toBeInstanceOf(ProvenanceError);
    expect(sessionFindOne).not.toHaveBeenCalled();
  });

  it("throws on a mutating request carrying neither Sec-Fetch-Site nor Origin", async () => {
    sessionFound(sessionRow());

    await expect(
      getAuthUser(withCookie(SESSION_TOKEN, {}, "POST"))
    ).rejects.toBeInstanceOf(ProvenanceError);
  });

  it("leaves a safe method alone even with no provenance headers", async () => {
    sessionFound(sessionRow());

    expect(await getAuthUser(withCookie(SESSION_TOKEN))).not.toBeNull();
  });

  it("does not apply the check to the Bearer path, which machines cannot satisfy", async () => {
    oauthTokenFindOne.mockResolvedValue({
      user: "u1",
      accessExpiresAt: new Date(Date.now() + DAY_MS),
      allowedProjects: [],
    });

    const result = await getAuthUser(
      request({ authorization: `Bearer ${MACHINE_TOKEN}` }, "POST")
    );

    expect(result?.viaMachineCredential).toBe(true);
  });
});

describe("getAuthUser — forwarded headers do not decide anything", () => {
  it("still refuses an unprefixed cookie when x-forwarded-proto claims http", async () => {
    sessionFound(sessionRow());

    const result = await getAuthUser(
      request({
        cookie: `bp_session=${SESSION_TOKEN}`,
        "x-forwarded-proto": "http",
        "x-forwarded-host": "localhost",
      })
    );

    expect(result).toBeNull();
    expect(sessionFindOne).not.toHaveBeenCalled();
  });

  it("does not let x-forwarded-host stand in for a missing Origin on a mutating request", async () => {
    sessionFound(sessionRow());
    process.env.APP_ORIGIN = "https://app.example.com";

    await expect(
      getAuthUser(
        withCookie(SESSION_TOKEN, { "x-forwarded-host": "app.example.com" }, "POST")
      )
    ).rejects.toBeInstanceOf(ProvenanceError);
  });
});
