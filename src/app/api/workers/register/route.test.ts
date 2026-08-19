import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const consumeEnrolmentToken = vi.fn();
const attachWorkerToEnrolment = vi.fn();
const enrolmentTokenOwner = vi.fn().mockResolvedValue("Rafal");
const enrolmentTokenOwnerId = vi.fn().mockResolvedValue("u1");
const registerWorker = vi.fn();

const logInstanceAudit = vi.fn();
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/enrolment", () => ({
  consumeEnrolmentToken,
  attachWorkerToEnrolment,
  enrolmentTokenOwner,
  enrolmentTokenOwnerId,
}));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, registerWorker };
});

const { POST } = await import("./route");

const WORKER = {
  _id: "w1",
  name: "rig-laptop",
  policy: { pollIntervalMs: 5000 },
  policyOverrides: ["pollIntervalMs"],
  repos: [],
};

function request(body: unknown, token?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-cp-protocol": "1",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/workers/register", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID = { name: "rig-laptop", host: "mac.home", platform: "darwin", version: "1.0.0" };

beforeEach(() => {
  vi.clearAllMocks();
  consumeEnrolmentToken.mockResolvedValue({ ok: true, tokenId: "e1" });
  attachWorkerToEnrolment.mockResolvedValue(undefined);
  registerWorker.mockResolvedValue({ worker: WORKER, credential: "cpw_secret" });
});

describe("POST /api/workers/register", () => {
  it("registers on a valid enrolment token and hands back a worker credential", async () => {
    const response = await POST(request(VALID, "cpe_good"));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.workerId).toBe("w1");
    expect(json.credential).toBe("cpw_secret");
    expect(consumeEnrolmentToken).toHaveBeenCalledWith("cpe_good");
  });

  it("records which worker spent the token", async () => {
    await POST(request(VALID, "cpe_good"));

    expect(attachWorkerToEnrolment).toHaveBeenCalledWith("e1", "w1");
  });

  // BP-358: enrolment is enrolment whichever door it comes through. This path has no admin session
  // to read a user from, but the token itself was minted by one — that person is the owner.
  it("passes the token's creator as the machine's owner", async () => {
    await POST(request(VALID, "cpe_good"));

    expect(registerWorker.mock.calls[0][0].ownerId).toBe("u1");
  });

  // BP-233. No user on this one: the caller is a machine holding a token and no session, which is
  // the fact worth recording — a token minted for one person and spent on an unexpected host is
  // the shape of a leaked enrolment.
  it("records the spend against the machine, with no user to attribute it to", async () => {
    await POST(request(VALID, "cpe_good"));

    const entry = logInstanceAudit.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: "enrolment_token_spent",
      target: "rig-laptop",
      detail: expect.stringContaining("mac.home"),
    });
    expect(entry.user).toBeUndefined();
  });

  // Whoever holds a valid enrolment token chooses these, and they now reach an admin-facing list.
  // The device flow already capped them; this path did not, and the audit row is what made an
  // oversized host somebody else's problem.
  it("caps the name and host a registering machine chooses for itself", async () => {
    await POST(request({ ...VALID, name: "n".repeat(500), host: "h".repeat(900) }, "cpe_good"));

    const registered = registerWorker.mock.calls[0][0];
    expect(registered.name).toHaveLength(120);
    expect(registered.host).toHaveLength(200);
  });

  it("records nothing when the token is refused", async () => {
    consumeEnrolmentToken.mockResolvedValue({ ok: false });

    await POST(request(VALID, "cpe_bad"));

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  // The property this whole credential exists for: no admin session, no admin API token, nothing
  // on the laptop that could reach PATCH /api/workers/:id and lift lockedByInstance.
  it("never consults the session — an admin identity does not register a worker", async () => {
    await POST(request(VALID, "cpe_good"));

    expect(getAuthUser).not.toHaveBeenCalled();
  });

  it("refuses a request with no enrolment token at all", async () => {
    consumeEnrolmentToken.mockResolvedValue({ ok: false, reason: "unknown" });

    const response = await POST(request(VALID));

    expect(response.status).toBe(401);
    expect(registerWorker).not.toHaveBeenCalled();
  });

  it("refuses a token another worker already spent", async () => {
    consumeEnrolmentToken.mockResolvedValue({ ok: false, reason: "used" });

    expect((await POST(request(VALID, "cpe_spent"))).status).toBe(401);
    expect(registerWorker).not.toHaveBeenCalled();
  });

  // Distinguishing "real but spent" from "never existed" would turn this into a guessing oracle
  it("says the same thing whether the token was spent, expired or invented", async () => {
    const messages: string[] = [];
    for (const reason of ["unknown", "used", "expired"]) {
      consumeEnrolmentToken.mockResolvedValue({ ok: false, reason });
      messages.push((await (await POST(request(VALID, "cpe_x"))).json()).error);
    }

    expect(new Set(messages).size).toBe(1);
  });

  // An operator gets one token; burning it on a missing field would mean minting another
  it("checks the request shape before spending the token", async () => {
    const response = await POST(request({ host: "mac.home" }, "cpe_good"));

    expect(response.status).toBe(400);
    expect(consumeEnrolmentToken).not.toHaveBeenCalled();
  });

  it("checks the protocol before spending the token", async () => {
    const req = new Request("http://localhost/api/workers/register", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cpe_good" },
      body: JSON.stringify(VALID),
    });

    expect((await POST(req)).status).toBe(409);
    expect(consumeEnrolmentToken).not.toHaveBeenCalled();
  });

  it("sends only the overridden machine policy, as the heartbeat does", async () => {
    const json = await (await POST(request(VALID, "cpe_good"))).json();

    expect(json.policy).toEqual({ pollIntervalMs: 5000 });
  });

  // A worker that has just registered has reported no checkouts, so nothing can be matched yet.
  // Its first heartbeat carries the inventory and gets the projects back.
  it("assigns nothing at registration, before the worker has reported what it has", async () => {
    const json = await (await POST(request(VALID, "cpe_good"))).json();

    expect(json.assignments).toEqual([]);
  });
});
