import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Deliberately not mockRejectedValue: that builds the rejected promise when the test sets it up
// rather than when the code under test calls it, and vitest then reports it as an unhandled
// rejection and fails the test whatever the middleware answered. Every case here passed and failed
// for the wrong reason until this was an implementation that throws when called.
function failsWith(error: unknown) {
  getAuthUser.mockImplementation(async () => {
    throw error;
  });
}

describe("withAuth when the database is unreachable", () => {
  // A block body, not `() => getAuthUser.mockReset()`: mockReset returns the mock, a function
  // that vitest then treats as this hook's teardown and calls after every test. That stray
  // call runs whatever implementation the test installed, and an implementation that throws
  // becomes a rejection nobody awaits — reported as an unhandled rejection against the test,
  // which fails whatever the middleware actually answered.
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

  // A 401 is what the browser client acts on: it clears the session and the guard redirects. The
  // status is the whole mechanism by which an outage became a logout.
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

  // withAdmin and every project gate compose onto withAuth, so they inherit this — asserted rather
  // than assumed, because the role check reads `user.role` and there is no user to read
  it("is inherited by withAdmin, which never reaches its role check", async () => {
    failsWith(new DatabaseUnavailableError(new Error("down")));
    const handler = vi.fn();

    const res = await withAdmin(handler)(request(), { params: params() });

    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});
