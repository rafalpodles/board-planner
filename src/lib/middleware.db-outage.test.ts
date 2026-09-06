import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const getAuthUser = vi.fn();

vi.mock("./auth", () => ({ getAuthUser }));
vi.mock("./worker-service", () => ({
  verifyWorkerCredential: vi.fn(),
  isApprovedFor: vi.fn(),
}));

const { withAuth, withAdmin } = await import("./middleware");
const { DatabaseUnavailableError } = await import("./db");
const { ProvenanceError } = await import("./session");

function request(): Request {
  return new Request("https://app.example.com/api/projects", { method: "GET" });
}

const params = () => Promise.resolve({});

function failsWith(error: unknown) {
  getAuthUser.mockImplementation(async () => {
    throw error;
  });
}

describe("withAuth when the database is unreachable", () => {
  beforeEach(() => {
    getAuthUser.mockReset();
  });

  it("answers 503 rather than 401", async () => {
    failsWith(new DatabaseUnavailableError(new Error("ECONNREFUSED")));
    const handler = vi.fn();

    const res = await withAuth(handler)(request(), { params: params() });

    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("says nothing about the session, and asks to be retried", async () => {
    failsWith(new DatabaseUnavailableError(new Error("ECONNREFUSED")));

    const res = await withAuth(vi.fn())(request(), { params: params() });
    const body = await res.json();

    expect(res.headers.get("Retry-After")).toBe("5");
    expect(body.error).toMatch(/not a problem with your session/i);
  });

  it("does not leak the connection string or driver detail", async () => {
    failsWith(
      new DatabaseUnavailableError(
        new Error("connect ECONNREFUSED mongodb://admin:hunter2@10.0.0.4:27017")
      )
    );

    const body = await (await withAuth(vi.fn())(request(), { params: params() })).json();

    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("10.0.0.4");
  });

  it("still answers 401 to a credential that genuinely resolved to nobody", async () => {
    getAuthUser.mockImplementation(async () => null);

    const res = await withAuth(vi.fn())(request(), { params: params() });

    expect(res.status).toBe(401);
  });

  it("still answers 403 to a refused provenance", async () => {
    failsWith(new ProvenanceError("cross-site"));

    const res = await withAuth(vi.fn())(request(), { params: params() });

    expect(res.status).toBe(403);
  });

  it("lets an unrelated failure through, so it is not silently reported as an outage", async () => {
    failsWith(new TypeError("something else entirely"));

    await expect(withAuth(vi.fn())(request(), { params: params() })).rejects.toThrow(
      "something else entirely"
    );
  });

  it("is inherited by withAdmin, which never reaches its role check", async () => {
    failsWith(new DatabaseUnavailableError(new Error("down")));
    const handler = vi.fn();

    const res = await withAdmin(handler)(request(), { params: params() });

    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withAuth beyond the credential", () => {
  beforeEach(() => {
    getAuthUser.mockReset();
    getAuthUser.mockImplementation(async () => ({ _id: "u1", role: "member" }));
  });

  function driverError(name: string, message = "connect ECONNREFUSED"): Error {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  it("answers 503 when the handler itself cannot reach the database", async () => {
    const handler = vi.fn(async () => {
      throw driverError("MongoServerSelectionError");
    });

    const res = await withAuth(handler)(request(), { params: params() });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  it("answers 503 for a query that timed out against the command buffer", async () => {
    const handler = vi.fn(async () => {
      throw driverError("MongooseError", "Operation `tasks.find()` buffering timed out after 10000ms");
    });

    expect((await withAuth(handler)(request(), { params: params() })).status).toBe(503);
  });

  it("lets an ordinary bug in a handler through, rather than calling it an outage", async () => {
    const handler = vi.fn(async () => {
      throw new TypeError("cannot read properties of undefined");
    });

    await expect(withAuth(handler)(request(), { params: params() })).rejects.toThrow(
      "cannot read properties of undefined"
    );
  });

  it("does not touch a handler's own response", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }, { status: 201 }));

    const res = await withAuth(handler)(request(), { params: params() });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("withAuth and the failure a live connection produces", () => {
  beforeEach(() => {
    getAuthUser.mockReset();
  });

  it("answers 503 to a raw driver error, not only to its own wrapper", async () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:27017");
    error.name = "MongooseServerSelectionError";
    getAuthUser.mockImplementation(async () => {
      throw error;
    });

    expect((await withAuth(vi.fn())(request(), { params: params() })).status).toBe(503);
  });
});

