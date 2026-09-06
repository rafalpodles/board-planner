import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const accessibleProjectIds = vi.fn();
const check = vi.fn();
const projectFind = vi.fn();
const projectCreate = vi.fn();
const projectDeleteOne = vi.fn();
const grantCreate = vi.fn();
const taskAggregate = vi.fn();
const sprintFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds, check }));
vi.mock("@/models/project", () => ({
  Project: { find: projectFind, create: projectCreate, deleteOne: projectDeleteOne },
}));
vi.mock("@/models/grant", () => ({ Grant: { create: grantCreate } }));
vi.mock("@/models/task", () => ({ Task: { aggregate: taskAggregate, findOne: vi.fn() } }));
vi.mock("@/models/sprint", () => ({ Sprint: { find: sprintFind } }));

const { GET, POST } = await import("./route");

const MEMBER = { _id: "u1", role: "member" };
const ADMIN = { _id: "a1", role: "admin" };
const NEW_PROJECT_ID = "p-new";

function projectDoc(id: string) {
  return { _id: id, toObject: () => ({ _id: id, name: `Project ${id}`, key: id.toUpperCase() }) };
}

function request() {
  return new Request("http://localhost/api/projects");
}

function post(body: unknown) {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(MEMBER);
  check.mockResolvedValue(false);
  projectFind.mockReturnValue({
    populate: () => ({ sort: () => Promise.resolve([projectDoc("p1")]) }),
  });
  projectCreate.mockImplementation((doc) =>
    Promise.resolve({
      _id: NEW_PROJECT_ID,
      ...doc,
      populate: () => Promise.resolve({ toObject: () => ({ _id: NEW_PROJECT_ID, ...doc }) }),
    })
  );
  projectDeleteOne.mockResolvedValue({ deletedCount: 1 });
  grantCreate.mockResolvedValue({ _id: "g1" });
  taskAggregate.mockResolvedValue([]);
  sprintFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
});

describe("GET /api/projects", () => {
  it("queries without a filter when the grant layer reports no restriction", async () => {
    accessibleProjectIds.mockResolvedValue(null);

    await GET(request(), ctx());

    expect(projectFind).toHaveBeenCalledWith({});
  });

  it("confines the query to the granted projects", async () => {
    accessibleProjectIds.mockResolvedValue(["p1"]);

    await GET(request(), ctx());

    expect(projectFind).toHaveBeenCalledWith({ _id: { $in: ["p1"] } });
  });

  it("reports canAdmin from the grant layer, per project", async () => {
    accessibleProjectIds.mockResolvedValue(["p1"]);
    check.mockResolvedValue(true);

    const body = await (await GET(request(), ctx())).json();

    expect(check).toHaveBeenCalledWith(MEMBER, "p1", "admin");
    expect(body[0].canAdmin).toBe(true);
  });
});

describe("POST /api/projects", () => {
  it("grants the creator ownership of the board it just created", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await POST(post({ name: "New", key: "NEW" }), ctx());

    expect(response.status).toBe(201);
    expect(grantCreate).toHaveBeenCalledWith({
      subject: ADMIN._id,
      relation: "owner",
      objectType: "project",
      object: NEW_PROJECT_ID,
      createdBy: ADMIN._id,
    });
  });

  it("records the creator on the project", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await POST(post({ name: "New", key: "NEW" }), ctx());

    expect(projectCreate.mock.calls[0][0].createdBy).toBe(ADMIN._id);
  });

  it("deletes the project and propagates when the owner grant cannot be written", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    grantCreate.mockRejectedValue(new Error("duplicate key"));

    await expect(POST(post({ name: "New", key: "NEW" }), ctx())).rejects.toThrow("duplicate key");

    expect(projectDeleteOne).toHaveBeenCalledWith({ _id: NEW_PROJECT_ID });
  });
});

describe("the key a project may be given", () => {
  it.each([
    ["a Slack link closer", "A><HTTPS://PHISH.EXAMPLE|RESET YOUR PASSWORD"],
    ["a Discord masked link", "A)[OPEN](HTTPS://PHISH.EXAMPLE)"],
    ["a Discord heading", "A#URGENT"],
    ["a newline", "A\nB"],
    ["a space", "A B"],
  ])("refuses %s, and creates nothing", async (_label, key) => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await POST(post({ name: "Phish", key }), ctx());

    expect(response.status).toBe(400);
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it("accepts an ordinary key, and stores what it will be stored as", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await POST(post({ name: "Board Planner", key: " bp " }), ctx());

    expect(response.status).toBe(201);
    expect(projectCreate.mock.calls[0][0].key).toBe("BP");
  });
});
