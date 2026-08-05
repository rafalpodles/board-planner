import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("./auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("./grants", () => ({ check, accessibleProjectIds: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findOne: projectFindOne, findById: vi.fn() } }));
vi.mock("@/models/user", () => ({ User: { findById: vi.fn() } }));
vi.mock("@/models/task", () => ({ Task: { findOne: vi.fn() } }));
vi.mock("./worker-service", () => ({ verifyWorkerCredential: vi.fn() }));

const { withProjectAccess, withProjectOwner } = await import("./middleware");

const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";
const MEMBER = { _id: "u1", role: "member" };
const INSTANCE_ADMIN = { _id: "a1", role: "admin" };

function request() {
  return new Request(`https://example.com/api/projects/${PROJECT_ID}`);
}

const context = (projectId = PROJECT_ID) => ({ params: Promise.resolve({ projectId }) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(MEMBER);
  check.mockResolvedValue(true);
});

describe("withProjectAccess", () => {
  it("asks the grant layer for access on the project in the path", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    await withProjectAccess(handler)(request(), context());

    expect(check).toHaveBeenCalledWith(MEMBER, PROJECT_ID, "access");
  });

  it("calls the handler when the grant layer allows it", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const res = await withProjectAccess(handler)(request(), context());

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses when the grant layer says no", async () => {
    check.mockResolvedValue(false);
    const handler = vi.fn();

    const res = await withProjectAccess(handler)(request(), context());

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  // Everything downstream queries Mongo with params.projectId, so the key has to be resolved
  // before it is authorised — authorising the key itself would ask about a project id that is not one
  it("resolves a project key to its id before deciding, and hands the id on", async () => {
    projectFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: PROJECT_ID }) });
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    await withProjectAccess(handler)(request(), context("CP"));

    expect(check).toHaveBeenCalledWith(MEMBER, PROJECT_ID, "access");
    expect(await handler.mock.calls[0][1].params).toEqual({ projectId: PROJECT_ID });
  });

  // An unknown key must look the same to a non-admin as one they cannot reach
  it("answers an unresolvable project with 403 to a member and 404 to an instance admin", async () => {
    projectFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    const handler = vi.fn();

    expect((await withProjectAccess(handler)(request(), context("NOPE"))).status).toBe(403);

    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    expect((await withProjectAccess(handler)(request(), context("NOPE"))).status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withProjectOwner", () => {
  it("asks for admin, not access", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    await withProjectOwner(handler)(request(), context());

    expect(check).toHaveBeenCalledWith(MEMBER, PROJECT_ID, "admin");
  });

  it("calls the handler when the grant layer allows it", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const res = await withProjectOwner(handler)(request(), context());

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses when the grant layer says no", async () => {
    check.mockResolvedValue(false);
    const handler = vi.fn();

    const res = await withProjectOwner(handler)(request(), context());

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});
