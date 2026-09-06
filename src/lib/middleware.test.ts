import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();

vi.mock("./worker-service", () => ({ verifyWorkerCredential }));

const { withWorker, protocolOf } = await import("./middleware");

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

  it("clears credentialHash before handing the worker to the handler", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: "w1", credentialHash: "$2a$10$realhash" });
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await withWorker(handler)(request({ authorization: "Bearer cpw_x", "x-worker-id": "w1" }), {
      params: paramsOf({ workerId: "w1" }),
    });

    expect(handler.mock.calls[0][1].worker.credentialHash).toBeFalsy();
  });
});
