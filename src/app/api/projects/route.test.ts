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

// null from accessibleProjectIds means "no restriction", not "no projects". Collapsing this to
// an unconditional {} shows every project to every member, and `?? []` hides every project from
// an instance admin — both are one-line mistakes the contract invites.
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

  // canAdmin gates every project-admin section of the settings page, so it has to be the grant
  // layer's answer and not a constant
  it("reports canAdmin from the grant layer, per project", async () => {
    accessibleProjectIds.mockResolvedValue(["p1"]);
    check.mockResolvedValue(true);

    const body = await (await GET(request(), ctx())).json();

    expect(check).toHaveBeenCalledWith(MEMBER, "p1", "admin");
    expect(body[0].canAdmin).toBe(true);
  });
});

// Nothing authorises from project.createdBy — it is informational. The creator's power over the
// new board comes from the owner grant, so a board created without one is a board nobody but an
// instance admin can administer.
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

  // Swallowing this leaves a board with no owner at all — worse than no board
  it("deletes the project and propagates when the owner grant cannot be written", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    grantCreate.mockRejectedValue(new Error("duplicate key"));

    await expect(POST(post({ name: "New", key: "NEW" }), ctx())).rejects.toThrow("duplicate key");

    expect(projectDeleteOne).toHaveBeenCalledWith({ _id: NEW_PROJECT_ID });
  });
});

/**
 * The key is interpolated into a task URL and from there into Slack and Discord message markup,
 * where `>` closes a link and `#` opens a heading. Escaping at each sink was tried three times and
 * missed something every time; this asserts the value never gets that far (BP-401).
 */
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

  // Without this the refusals above would pass just as well on a route that refuses everything
  it("accepts an ordinary key, and stores what it will be stored as", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await POST(post({ name: "Board Planner", key: " bp " }), ctx());

    expect(response.status).toBe(201);
    expect(projectCreate.mock.calls[0][0].key).toBe("BP");
  });
});
