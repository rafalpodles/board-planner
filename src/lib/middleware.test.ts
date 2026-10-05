import { Types } from "mongoose";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { verifyWorkerCredential, getAuthUser, getOrganisation, userExists } = vi.hoisted(() => ({
  userExists: vi.fn(),
  verifyWorkerCredential: vi.fn(),
  getAuthUser: vi.fn(),
  getOrganisation: vi.fn(),
}));

vi.mock("./worker-service", () => ({ verifyWorkerCredential }));
const organisationOfRequest = vi.hoisted(() => vi.fn());
vi.mock("./organisation-host", () => ({ organisationOfRequest }));
vi.mock("./auth", () => ({ getAuthUser }));
vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("./organisation", () => ({ getOrganisation }));
vi.mock("@/models/user", () => ({ User: { exists: userExists } }));

const { withWorker, withAuth, protocolOf, withEntitlement, refusedOnThisHost } = await import("./middleware");
const { scoped } = await import("./db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("./organisation-field");

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/workers/w1/heartbeat", {
    method: "POST",
    headers,
  });
}

function paramsOf(record: Record<string, string> = {}) {
  return Promise.resolve(record);
}

describe("protocolOf", () => {
  it("parses a present header to a number", () => {
    expect(protocolOf(request({ "x-cp-protocol": "3" }))).toBe(3);
  });

  it("is NaN when the header is absent", () => {
    expect(Number.isNaN(protocolOf(request()))).toBe(true);
  });
});

describe("withWorker", () => {
  beforeEach(() => verifyWorkerCredential.mockReset());

  it("rejects when there is no Authorization header", async () => {
    const handler = vi.fn();
    const res = await withWorker(handler)(request({ "x-worker-id": "w1" }), {
      params: paramsOf(),
    });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(verifyWorkerCredential).not.toHaveBeenCalled();
  });

  it("rejects a non-Bearer authorization scheme", async () => {
    const handler = vi.fn();
    const res = await withWorker(handler)(
      request({ authorization: "Basic abc", "x-worker-id": "w1" }),
      { params: paramsOf() }
    );

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(verifyWorkerCredential).not.toHaveBeenCalled();
  });

  it("rejects a missing x-worker-id without calling verifyWorkerCredential", async () => {
    const handler = vi.fn();
    const res = await withWorker(handler)(request({ authorization: "Bearer cpw_x" }), {
      params: paramsOf(),
    });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(verifyWorkerCredential).not.toHaveBeenCalled();
  });

  it("rejects a credential the service does not recognize", async () => {
    verifyWorkerCredential.mockResolvedValue(null);
    const handler = vi.fn();

    const res = await withWorker(handler)(
      request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }),
      { params: paramsOf() }
    );

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  // BP-832. A machine reaches what its owner reaches; a deactivated owner reaches nothing
  it("rejects a machine whose owner is deactivated, with its own credential", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: "w1", owner: "u9", credentialHash: "hash" });
    userExists.mockResolvedValueOnce({ _id: "u9" });
    const handler = vi.fn();

    const res = await withWorker(handler)(
      request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }),
      { params: paramsOf({ workerId: "w1" }) }
    );

    expect(res.status).toBe(401);
    expect(userExists).toHaveBeenCalledWith({ _id: "u9", deactivatedAt: { $ne: null }, organisation: DEFAULT_ORGANISATION_ID });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects when the path's workerId names a different worker than the credential", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: "w1", credentialHash: "hash" });
    const handler = vi.fn();

    const res = await withWorker(handler)(
      request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }),
      { params: paramsOf({ workerId: "someone-else" }) }
    );

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls the handler with the worker the credential resolved when params.workerId matches", async () => {
    const resolved = { _id: "w1", credentialHash: "hash" };
    verifyWorkerCredential.mockResolvedValue(resolved);
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const res = await withWorker(handler)(
      request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }),
      { params: paramsOf({ workerId: "w1" }) }
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1].worker).toBe(resolved);
    expect(res.status).toBe(200);
  });

  it("calls the handler on a route with no workerId param at all", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: "w1", credentialHash: "hash" });
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const res = await withWorker(handler)(
      request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }),
      { params: paramsOf({}) }
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  // select: false only suppresses the default query projection; once verifyWorkerCredential
  // re-selects it, the hash survives on the document unless withWorker clears it explicitly
  it("clears credentialHash before handing the worker to the handler", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: "w1", credentialHash: "$2a$10$realhash" });
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await withWorker(handler)(request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }), {
      params: paramsOf({ workerId: "w1" }),
    });

    expect(handler.mock.calls[0][1].worker.credentialHash).toBeFalsy();
  });
});

beforeEach(() => {
  organisationOfRequest.mockReset().mockResolvedValue({ kind: "organisation", organisation: DEFAULT_ORGANISATION_ID });
});

describe("the db a handler is handed (BP-663)", () => {
  const OTHER = "0000000000000000000000b2";
  const onOthersHost = () =>
    organisationOfRequest.mockResolvedValue({ kind: "organisation", organisation: Types.ObjectId.createFromHexString(OTHER) });

  it("withAuth confines it to the signed-in user's organisation", async () => {
    onOthersHost();
    getAuthUser.mockResolvedValue({ _id: "u1", organisation: OTHER });
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await withAuth(handler)(request(), { params: paramsOf() });

    expect(handler.mock.calls[0][1].db).toBe(scoped(OTHER));
    expect(handler.mock.calls[0][1].db).not.toBe(scoped(DEFAULT_ORGANISATION_ID));
  });

  it("withAuth runs the handler with the user's organisation in every log line (BP-894)", async () => {
    onOthersHost();
    getAuthUser.mockResolvedValue({ _id: "u1", organisation: OTHER });
    const { loggingOrganisation } = await import("./organisation-log");
    let logged: string | undefined;

    await withAuth(async () => {
      await Promise.resolve();
      logged = loggingOrganisation();
      return new Response(null, { status: 200 });
    })(request(), { params: paramsOf() });

    expect(logged).toBe(OTHER);
  });

  it("withWorker confines it to the machine's organisation", async () => {
    onOthersHost();
    verifyWorkerCredential.mockResolvedValue({ _id: "w1", organisation: OTHER, credentialHash: "hash" });
    userExists.mockResolvedValue(null);
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await withWorker(handler)(request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }), {
      params: paramsOf({}),
    });

    expect(handler.mock.calls[0][1].db).toBe(scoped(OTHER));
  });
});

describe("a credential on another organisation's host (BP-666)", () => {
  const OTHER = "0000000000000000000000b2";

  it("is refused like no credential, and the handler never runs", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", organisation: OTHER });
    const handler = vi.fn();

    const res = await withAuth(handler)(request(), { params: paramsOf() });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a machine credential the same way", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: "w1", organisation: OTHER, credentialHash: "hash" });
    const handler = vi.fn();

    const res = await withWorker(handler)(request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }), {
      params: paramsOf({}),
    });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 404 on a host that names no organisation, before anything else", async () => {
    organisationOfRequest.mockResolvedValue({ kind: "none" });
    getAuthUser.mockResolvedValue({ _id: "u1" });
    const handler = vi.fn();

    const res = await withAuth(handler)(request(), { params: paramsOf() });

    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 503, not 500, when the host's organisation cannot be read for a database outage", async () => {
    const { DatabaseUnavailableError } = await import("./db-errors");
    organisationOfRequest.mockRejectedValue(new DatabaseUnavailableError(new Error("down")));
    getAuthUser.mockResolvedValue({ _id: "u1" });

    const res = await refusedOnThisHost(request(), { organisation: null });

    expect(res?.status).toBe(503);
  });

  it("answers 404 on the platform host too", async () => {
    organisationOfRequest.mockResolvedValue({ kind: "platform" });
    getAuthUser.mockResolvedValue({ _id: "u1" });

    expect((await withAuth(vi.fn())(request(), { params: paramsOf() })).status).toBe(404);
  });
});

function entitlementsRequest(): Request {
  return new Request("https://example.com/api/test-route", { method: "POST" });
}

describe("withEntitlement", () => {
  const USER = { _id: "u1", username: "member", role: "member" };

  beforeEach(() => {
    getAuthUser.mockReset();
    getOrganisation.mockReset();
    getAuthUser.mockResolvedValue(USER);
  });

  it("answers 402 with the feature and plan for an organisation that lacks it", async () => {
    getOrganisation.mockResolvedValue({ entitlements: { plan: "free", features: [] } });
    const handler = vi.fn();

    const res = await withEntitlement("integrations.coda")(handler)(entitlementsRequest(), {
      params: paramsOf(),
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual(
      expect.objectContaining({ feature: "integrations.coda", plan: "free" })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes through to the handler for an organisation that has the feature", async () => {
    getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [] } });
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const res = await withEntitlement("integrations.coda")(handler)(entitlementsRequest(), {
      params: paramsOf(),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("still requires authentication first", async () => {
    getAuthUser.mockResolvedValue(null);
    const handler = vi.fn();

    const res = await withEntitlement("integrations.coda")(handler)(entitlementsRequest(), {
      params: paramsOf(),
    });

    expect(res.status).toBe(401);
    expect(getOrganisation).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
