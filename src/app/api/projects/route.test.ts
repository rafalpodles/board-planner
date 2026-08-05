import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const accessibleProjectIds = vi.fn();
const check = vi.fn();
const projectFind = vi.fn();
const taskAggregate = vi.fn();
const sprintFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds, check }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind, create: vi.fn() } }));
vi.mock("@/models/task", () => ({ Task: { aggregate: taskAggregate, findOne: vi.fn() } }));
vi.mock("@/models/sprint", () => ({ Sprint: { find: sprintFind } }));

const { GET } = await import("./route");

const MEMBER = { _id: "u1", role: "member" };

function projectDoc(id: string) {
  return { _id: id, toObject: () => ({ _id: id, name: `Project ${id}`, key: id.toUpperCase() }) };
}

function request() {
  return new Request("http://localhost/api/projects");
}

const ctx = () => ({ params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(MEMBER);
  check.mockResolvedValue(false);
  projectFind.mockReturnValue({
    populate: () => ({ sort: () => Promise.resolve([projectDoc("p1")]) }),
  });
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
