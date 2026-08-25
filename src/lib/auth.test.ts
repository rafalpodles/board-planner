import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const userFindById = vi.fn();
const apiTokenFind = vi.fn();
const apiTokenFindByIdAndUpdate = vi.fn();
const oauthTokenFindOne = vi.fn();
const sessionFindOne = vi.fn();
const sessionUpdateOne = vi.fn();
const bcryptCompare = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
// A plain array, not a spy: beforeEach clears mocks, and this call happens once at module load
const hashSyncCalls: unknown[][] = [];
const bcryptHashSync = (...args: unknown[]) => {
  hashSyncCalls.push(args);
  return "$2a$10$absent";
};
vi.mock("bcryptjs", () => ({
  default: { compare: bcryptCompare, hashSync: bcryptHashSync },
}));
const userFindOne = vi.fn();
vi.mock("@/models/user", () => ({ User: { findById: userFindById, findOne: userFindOne } }));
vi.mock("@/models/apiToken", () => ({
  ApiToken: { find: apiTokenFind, findByIdAndUpdate: apiTokenFindByIdAndUpdate },
}));
vi.mock("@/models/oauthToken", () => ({ OAuthToken: { findOne: oauthTokenFindOne } }));
vi.mock("@/models/session", () => ({
  Session: { findOne: sessionFindOne, updateOne: sessionUpdateOne },
}));

const { getAuthUser, verifyCredentials, PASSWORD_COST_FACTOR } = await import("./auth");
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

describe("getAuthUser — an OAuth row that cannot be shown to be live", () => {
  // BP-444: every stale shape here answers 401, and one of them arrived there by throwing. A row
  // whose expiry is missing read `.getTime()` off undefined, so an ordinary refusal left the
  // module as a TypeError — 401 downstream only because mcp-handler catches everything.
  it.each([
    ["missing", undefined],
    ["null", null],
  ])("refuses a row whose accessExpiresAt is %s without throwing", async (_label, value) => {
    oauthTokenFindOne.mockResolvedValue({
      user: "u1",
      accessExpiresAt: value,
      allowedProjects: [],
    });

    await expect(
      getAuthUser(request({ authorization: `Bearer ${MACHINE_TOKEN}` }))
    ).resolves.toBeNull();
    // The refusal is the token's, not the user's: reaching the user lookup would mean the row was
    // read as live
    expect(userFindById).not.toHaveBeenCalled();
  });

  it("still refuses a plainly expired row, and still admits a live one", async () => {
    oauthTokenFindOne.mockResolvedValue({
      user: "u1",
      accessExpiresAt: new Date(Date.now() - 1000),
      allowedProjects: [],
    });
    await expect(
      getAuthUser(request({ authorization: `Bearer ${MACHINE_TOKEN}` }))
    ).resolves.toBeNull();

    oauthTokenFindOne.mockResolvedValue({
      user: "u1",
      accessExpiresAt: new Date(Date.now() + DAY_MS),
      allowedProjects: [],
    });
    userFindById.mockResolvedValue(user());
    await expect(
      getAuthUser(request({ authorization: `Bearer ${MACHINE_TOKEN}` }))
    ).resolves.toMatchObject({ username: "rpo" });
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
    // Without this the assertion above is satisfied by the default empty Session collection and
    // would pass against code that has no cookie support at all
    expect(sessionFindOne).toHaveBeenCalledWith({ tokenHash: sha256(MACHINE_TOKEN) });
  });

  it("refuses a cpat_ in the cookie even when a session row happens to carry that hash", async () => {
    sessionFound(sessionRow());
    oauthTokenFindOne.mockResolvedValue({
      user: "u1",
      accessExpiresAt: new Date(Date.now() + DAY_MS),
      allowedProjects: [],
    });

    const result = await getAuthUser(withCookie(MACHINE_TOKEN));

    // A row keyed on sha256(cpat_) can only exist if someone put it there; it is still a session,
    // so it must not carry machine authority
    expect(result?.viaMachineCredential).toBe(false);
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

describe("getAuthUser — a presented Bearer never falls back to the cookie", () => {
  it("returns null for an unrecognised Bearer prefix even with a live session cookie", async () => {
    sessionFound(sessionRow());

    const result = await getAuthUser(
      request({
        authorization: "Bearer not-a-recognised-prefix",
        cookie: `__Host-bp_session=${SESSION_TOKEN}`,
      })
    );

    // /api/mcp gates on the header merely being present, so falling through here would hand it an
    // AuthInfo for a token nothing validated, authenticated by a cookie that rode along
    expect(result).toBeNull();
    expect(sessionFindOne).not.toHaveBeenCalled();
  });

  it("still resolves the cookie when no Authorization header is sent", async () => {
    sessionFound(sessionRow());

    const result = await getAuthUser(withCookie(SESSION_TOKEN));

    expect(result?.viaMachineCredential).toBe(false);
  });
});

describe("getAuthUser — the five machine-gated endpoints", () => {
  // Each gate is `if (user.viaMachineCredential) return 403`, so a cookie principal must carry a
  // strict false rather than an absent property
  it("gives a cookie session a strict false, which is what the gates test", async () => {
    sessionFound(sessionRow());

    const result = await getAuthUser(withCookie(SESSION_TOKEN));

    expect(result).not.toBeNull();
    expect(result!.viaMachineCredential).toBe(false);
    expect(Object.is(result!.viaMachineCredential, undefined)).toBe(false);
  });

  it("keeps a strict true on both machine paths", async () => {
    oauthTokenFindOne.mockResolvedValue({
      user: "u1",
      accessExpiresAt: new Date(Date.now() + DAY_MS),
      allowedProjects: [],
    });
    const viaOauth = await getAuthUser(request({ authorization: `Bearer ${MACHINE_TOKEN}` }));
    expect(viaOauth?.viaMachineCredential).toBe(true);

    bcryptCompare.mockResolvedValue(true);
    apiTokenFind.mockReturnValue({
      lean: () =>
        Promise.resolve([{ _id: "t1", user: "u1", tokenHash: "hashed", allowedProjects: [] }]),
    });
    const viaToken = await getAuthUser(request({ authorization: `Bearer cp_${"c".repeat(64)}` }));
    expect(viaToken?.viaMachineCredential).toBe(true);
  });
});

// BP-318: the miss path returned before bcrypt, so an unknown username answered in single-digit
// milliseconds against ~100 ms for a real one — a username oracle on /api/auth/login and
// /oauth/authorize that needs no statistics to read.
describe("verifyCredentials and the username oracle", () => {
  function lookupReturns(user: unknown) {
    userFindOne.mockReturnValue({ select: () => Promise.resolve(user) });
  }

  it("compares against a hash even when no such user exists", async () => {
    lookupReturns(null);

    const result = await verifyCredentials("nobody", "hunter2");

    expect(result).toBeNull();
    expect(bcryptCompare).toHaveBeenCalledTimes(1);
    expect(bcryptCompare.mock.calls[0][0]).toBe("hunter2");
  });

  it("does the same amount of comparing for a hit and a miss", async () => {
    lookupReturns(null);
    await verifyCredentials("nobody", "hunter2");
    const onMiss = bcryptCompare.mock.calls.length;

    bcryptCompare.mockClear();
    lookupReturns({ username: "rpo", password: "$2a$10$stored" });
    bcryptCompare.mockResolvedValue(true);
    await verifyCredentials("rpo", "hunter2");

    expect(bcryptCompare.mock.calls.length).toBe(onMiss);
  });

  // The stand-in must be a real hash comparison, not a cheap string compare that returns at once
  // Counting calls is not enough: comparing against a string that is not a hash returns in
  // microseconds and restores the oracle with the suite green. Pin what it compares against.
  it("compares against the module's own hash, not against something cheap", async () => {
    lookupReturns(null);

    await verifyCredentials("nobody", "hunter2");

    // The mocked hashSync returns this; the assertion is that the compare uses what the module
    // hashed at load, not a literal that bcrypt would reject in microseconds
    expect(bcryptCompare.mock.calls[0][1]).toBe("$2a$10$absent");
  });

  it("generates that hash once, at the factor stored passwords use", () => {
    expect(hashSyncCalls.length).toBe(1);
    expect(hashSyncCalls[0][1]).toBe(PASSWORD_COST_FACTOR);
  });

  it("still refuses a wrong password for a user that does exist", async () => {
    lookupReturns({ username: "rpo", password: "$2a$10$stored" });
    bcryptCompare.mockResolvedValue(false);

    expect(await verifyCredentials("rpo", "wrong")).toBeNull();
  });
});
