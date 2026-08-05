import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const consumeEnrolmentToken = vi.fn();
const attachWorkerToEnrolment = vi.fn();
const enrolmentTokenOwner = vi.fn().mockResolvedValue("Rafal");
const registerWorker = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/enrolment", () => ({ consumeEnrolmentToken, attachWorkerToEnrolment, enrolmentTokenOwner }));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, registerWorker };
});

const { POST } = await import("./route");

const WORKER = {
  _id: "w1",
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
