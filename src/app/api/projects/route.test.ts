import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";
import { PROJECT_ICONS } from "@/types";

const getAuthUser = vi.fn();
const accessibleProjectIds = vi.fn();
const administeredProjectIds = vi.fn();
const projectFind = vi.fn();
const projectCreate = vi.fn();
const projectDeleteOne = vi.fn();
const grantCreate = vi.fn();
const grantInsertMany = vi.fn();
const grantDeleteMany = vi.fn();
const userFind = vi.fn();
const logProjectAudit = vi.fn();
const auditAccess = vi.fn();
const announceAccess = vi.fn();
const taskAggregate = vi.fn();
const sprintFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds, administeredProjectIds }));
vi.mock("@/models/project", () => ({
  Project: { find: projectFind, create: projectCreate, deleteOne: projectDeleteOne },
}));
vi.mock("@/models/grant", () => ({
  Grant: { create: grantCreate, insertMany: grantInsertMany, deleteMany: grantDeleteMany },
}));
vi.mock("@/models/user", () => ({ User: { find: userFind } }));
vi.mock("@/lib/board-access", () => ({ auditAccess, announceAccess }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/models/task", () => ({ Task: { aggregate: taskAggregate, findOne: vi.fn() } }));
vi.mock("@/models/sprint", () => ({ Sprint: { find: sprintFind } }));

const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
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
  administeredProjectIds.mockResolvedValue(new Set());
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
  grantInsertMany.mockResolvedValue([]);
  grantDeleteMany.mockResolvedValue({ deletedCount: 0 });
  userFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  announceAccess.mockResolvedValue(undefined);
  taskAggregate.mockResolvedValue([]);
  sprintFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
});

// null from accessibleProjectIds means "no restriction", not "no projects". Collapsing this to
// an unconditional {} shows every project to every member, and `?? []` hides every project from
// an instance admin — both are one-line mistakes the contract invites.
describe("GET /api/projects — task counts", () => {
  it("count the tasks nobody archived", async () => {
    accessibleProjectIds.mockResolvedValue(null);

    await GET(request(), ctx());

    const stages = taskAggregate.mock.calls[0][0] as { $match?: Record<string, unknown> }[];
    expect(stages.find((stage) => stage.$match?.project)?.$match).toMatchObject({ archivedAt: null });
  });
});

describe("GET /api/projects", () => {
  it("queries without a filter when the grant layer reports no restriction", async () => {
    accessibleProjectIds.mockResolvedValue(null);

    await GET(request(), ctx());

    expect(projectFind).toHaveBeenCalledWith({ organisation: DEFAULT_ORGANISATION_ID });
  });

  it("confines the query to the granted projects", async () => {
    accessibleProjectIds.mockResolvedValue(["p1"]);

    await GET(request(), ctx());

    expect(projectFind).toHaveBeenCalledWith({ _id: { $in: ["p1"] }, organisation: DEFAULT_ORGANISATION_ID });
  });

  // canAdmin gates every project-admin section of the settings page, so it has to be the grant
  // layer's answer and not a constant
  it("reports canAdmin from the grant layer, for the whole list in one call", async () => {
    accessibleProjectIds.mockResolvedValue(["p1"]);
    administeredProjectIds.mockResolvedValue(new Set(["p1"]));

    const body = await (await GET(request(), ctx())).json();

    expect(administeredProjectIds).toHaveBeenCalledTimes(1);
    expect(administeredProjectIds).toHaveBeenCalledWith(scopedToDefaultOrganisation(), MEMBER, ["p1"]);
    expect(body[0].canAdmin).toBe(true);
  });

  it("reports canAdmin false for a project the grant layer leaves out", async () => {
    accessibleProjectIds.mockResolvedValue(["p1"]);

    const body = await (await GET(request(), ctx())).json();

    expect(body[0].canAdmin).toBe(false);
  });
});

// Nothing authorises from project.createdBy — it is informational. The creator's power over the
// new board comes from the owner grant, so a board created without one is a board nobody but an
// instance admin can administer.
describe("POST /api/projects", () => {
  // BP-753: the form now suggests keys, so two similar names collide far more often than before
  it("answers a key another board holds with 409, not 500, and grants nothing", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    projectCreate.mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000, keyPattern: { key: 1 } })
    );

    const response = await POST(post({ name: "Orbital", key: "ORB" }), ctx());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "That key is already used by another board" });
    expect(grantCreate).not.toHaveBeenCalled();
  });

  it("still fails loudly on a write error that is not a collision", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    projectCreate.mockRejectedValueOnce(new Error("disk full"));

    await expect(POST(post({ name: "Orbital", key: "ORB" }), ctx())).rejects.toThrow("disk full");
  });

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
      organisation: DEFAULT_ORGANISATION_ID,
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

    expect(projectDeleteOne).toHaveBeenCalledWith({ _id: NEW_PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID });
  });
});

// BP-199: the new-project wizard collects everything first and creates the board in one request, so
// a failure at any point must leave nothing behind and a success must be the board the person saw
describe("POST /api/projects — a project created with its setup", () => {
  const ANNA = "64b0000000000000000000a1";
  const PIOTR = "64b0000000000000000000a2";
  const SETUP_COLUMNS = [
    { label: "Backlog", role: "backlog" },
    { label: "To Do", role: "approved" },
    { label: "Doing", role: "active" },
    { label: "Done", role: "done" },
  ];

  function people(...rows: { _id: string; username: string }[]) {
    userFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });
  }

  it("stores the icon, columns, categories, repository and PM switch it was given", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await POST(
      post({
        name: "Search Revamp",
        key: "SR",
        icon: PROJECT_ICONS[1],
        columns: SETUP_COLUMNS,
        categories: [{ name: "bug", color: "#ef4444" }],
        repositoryUrl: " https://github.com/acme/search ",
        pm: { enabled: true },
      }),
      ctx()
    );

    expect(response.status).toBe(201);
    const created = projectCreate.mock.calls[0][0];
    expect(created.icon).toBe(PROJECT_ICONS[1]);
    expect(created.columns.map((c: { id: string; role: string; order: number }) => [c.id, c.role, c.order])).toEqual([
      ["backlog", "backlog", 0],
      ["to_do", "approved", 1],
      ["doing", "active", 2],
      ["done", "done", 3],
    ]);
    expect(created.categories).toEqual([{ name: "bug", color: "#ef4444" }]);
    expect(created.repositoryUrl).toBe("https://github.com/acme/search");
    expect(created.pm).toEqual({ enabled: true });
  });

  // Empty and false are answers, not absences: an empty list is a board with none, and "" is no icon
  it("passes empty and false values on, rather than treating them as not sent", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await POST(post({ name: "Bare", key: "BAR", categories: [], icon: "", pm: { enabled: false } }), ctx());

    const created = projectCreate.mock.calls[0][0];
    expect(created.categories).toEqual([]);
    expect(created.icon).toBe("");
    expect(created.pm).toEqual({ enabled: false });
  });

  it("treats null like a field that was not sent", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await POST(
      post({ name: "Nulls", key: "NUL", columns: null, categories: null, icon: null, access: null }),
      ctx()
    );

    expect(response.status).toBe(201);
    for (const field of ["icon", "columns", "categories"]) {
      expect(projectCreate.mock.calls[0][0]).not.toHaveProperty(field);
    }
  });

  it("leaves a trace of the PM agent and the repository it was created with", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await POST(
      post({ name: "Traced", key: "TRC", pm: { enabled: true }, repositoryUrl: "https://github.com/acme/web" }),
      ctx()
    );

    expect(logProjectAudit).toHaveBeenCalledWith(
      expect.anything(),
      NEW_PROJECT_ID,
      ADMIN._id,
      "settings_updated",
      ["PM agent: enabled at creation", "Repository: https://github.com/acme/web"]
    );
  });

  it("writes no settings trace for a project created with none of it", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await POST(post({ name: "Plain", key: "PLN" }), ctx());

    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  // Without this the test above would pass on a route that always writes every field
  it("leaves the schema defaults alone for everything it was not given", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await POST(post({ name: "Plain", key: "PLN" }), ctx());

    const created = projectCreate.mock.calls[0][0];
    for (const field of ["icon", "columns", "categories", "repositoryUrl", "pm"]) {
      expect(created).not.toHaveProperty(field);
    }
    expect(grantInsertMany).not.toHaveBeenCalled();
  });

  it("starts the Component and Labels fields with the options it was given", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await POST(
      post({
        name: "Fields",
        key: "FLD",
        components: ["api", "web"],
        labels: [{ name: "Security", color: "#ef4444" }, "Needs docs"],
      }),
      ctx()
    );

    const fields = projectCreate.mock.calls[0][0].customFields as {
      name: string;
      options: { value: string; color: string }[];
    }[];
    const options = (name: string) => fields.find((f) => f.name === name)?.options.map((o) => [o.value, o.color]);
    expect(options("Component")?.map(([value]) => value)).toEqual(["api", "web"]);
    expect(options("Labels")?.[0]).toEqual(["Security", "#ef4444"]);
    expect(options("Labels")?.[1][0]).toBe("Needs docs");
    // The Difficulty field is not the wizard's to change
    expect(options("Difficulty")?.map(([value]) => value)).toEqual(["S", "M", "L", "XL"]);
  });

  it("grants everyone it was given access for in one write, as the creator", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    people({ _id: ANNA, username: "anna" }, { _id: PIOTR, username: "piotr" });

    const response = await POST(
      post({
        name: "Shared",
        key: "SHR",
        access: [
          { userId: ANNA, relation: "member" },
          { userId: PIOTR, relation: "owner" },
        ],
      }),
      ctx()
    );

    expect(response.status).toBe(201);
    expect(grantInsertMany).toHaveBeenCalledTimes(1);
    expect(grantInsertMany.mock.calls[0][0]).toEqual([
      expect.objectContaining({ subject: ANNA, relation: "member", object: NEW_PROJECT_ID, createdBy: ADMIN._id }),
      expect.objectContaining({ subject: PIOTR, relation: "owner", object: NEW_PROJECT_ID, createdBy: ADMIN._id }),
    ]);
  });

  it("looks the people up as live human accounts of this organisation", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    people({ _id: ANNA, username: "anna" });

    await POST(post({ name: "Shared", key: "SHR", access: [{ userId: ANNA, relation: "member" }] }), ctx());

    expect(userFind).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: [ANNA] },
        kind: { $ne: "machine" },
        deactivatedAt: null,
        organisation: DEFAULT_ORGANISATION_ID,
      })
    );
  });

  it("does not grant the creator a second time when the request lists them", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, _id: ANNA });

    const response = await POST(
      post({ name: "Mine", key: "MNE", access: [{ userId: ANNA, relation: "member" }] }),
      ctx()
    );

    expect(response.status).toBe(201);
    expect(grantCreate).toHaveBeenCalledTimes(1);
    expect(grantCreate.mock.calls[0][0]).toMatchObject({ relation: "owner" });
    expect(grantInsertMany).not.toHaveBeenCalled();
    // Told nothing: the creator is not somebody who was added
    expect(auditAccess).not.toHaveBeenCalled();
    expect(announceAccess).not.toHaveBeenCalled();
  });

  it("records and announces only the others when the request also lists the creator", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, _id: ANNA });
    people({ _id: PIOTR, username: "piotr" });

    await POST(
      post({
        name: "Mine",
        key: "MNE",
        access: [
          { userId: ANNA, relation: "member" },
          { userId: PIOTR, relation: "member" },
        ],
      }),
      ctx()
    );

    expect(auditAccess).toHaveBeenCalledTimes(1);
    expect(announceAccess).toHaveBeenCalledTimes(1);
    expect(announceAccess.mock.calls[0][1]).toMatchObject({ recipientId: PIOTR });
  });

  it("creates nothing when somebody it was asked to add is gone or deactivated", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    people({ _id: ANNA, username: "anna" });

    const response = await POST(
      post({
        name: "Ghosts",
        key: "GHO",
        access: [
          { userId: ANNA, relation: "member" },
          { userId: PIOTR, relation: "member" },
        ],
      }),
      ctx()
    );

    expect(response.status).toBe(400);
    expect(projectCreate).not.toHaveBeenCalled();
    expect(grantCreate).not.toHaveBeenCalled();
  });

  // A board with half its people is worse than no board: the person sees an error and creates it again
  it("removes the project and every grant that landed when the others cannot be written", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    people({ _id: ANNA, username: "anna" });
    grantInsertMany.mockRejectedValue(new Error("write failed"));

    await expect(
      POST(post({ name: "Shared", key: "SHR", access: [{ userId: ANNA, relation: "member" }] }), ctx())
    ).rejects.toThrow("write failed");

    expect(grantDeleteMany).toHaveBeenCalledWith({
      objectType: "project",
      object: NEW_PROJECT_ID,
      organisation: DEFAULT_ORGANISATION_ID,
    });
    expect(projectDeleteOne).toHaveBeenCalledWith({ _id: NEW_PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID });
  });

  it("still removes the project when removing the grants fails too", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    people({ _id: ANNA, username: "anna" });
    grantInsertMany.mockRejectedValue(new Error("write failed"));
    grantDeleteMany.mockRejectedValue(new Error("still down"));

    await expect(
      POST(post({ name: "Shared", key: "SHR", access: [{ userId: ANNA, relation: "member" }] }), ctx())
    ).rejects.toThrow("write failed");

    expect(projectDeleteOne).toHaveBeenCalledWith({ _id: NEW_PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID });
  });

  it("records and announces each person it added, and nobody else", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, fullName: "Ada Admin", username: "ada" });
    people({ _id: ANNA, username: "anna" });

    await POST(post({ name: "Shared", key: "SHR", access: [{ userId: ANNA, relation: "owner" }] }), ctx());

    expect(auditAccess).toHaveBeenCalledTimes(1);
    expect(auditAccess).toHaveBeenCalledWith(
      expect.anything(),
      NEW_PROJECT_ID,
      ADMIN._id,
      "anna",
      undefined,
      "owner"
    );
    expect(announceAccess).toHaveBeenCalledTimes(1);
    expect(announceAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipientId: ANNA, relation: "owner", added: true, actorName: "Ada Admin" })
    );
  });

  it.each([
    ["no column means Done", { columns: [{ label: "Doing", role: "active" }] }],
    ["no column means In progress", { columns: [{ label: "Done", role: "done" }] }],
    [
      "more columns than a board may have, on a board that has every role it needs",
      {
        columns: [
          { label: "Doing", role: "active" },
          { label: "Done", role: "done" },
          ...Array.from({ length: 11 }, (_, i) => ({ label: `C${i}`, role: "backlog" })),
        ],
      },
    ],
    ["a second column handing over to the PM", { columns: [
      { label: "Doing", role: "active" }, { label: "Done", role: "done" },
      { label: "A", role: "review", triggersPmReview: true }, { label: "B", role: "review", triggersPmReview: true },
    ] }],
    ["a category named twice", { categories: [{ name: "Bug" }, { name: "bug" }] }],
    ["an icon the picker does not offer", { icon: "not-an-icon" }],
    ["a person with a role that does not exist", { access: [{ userId: "64b0000000000000000000a1", relation: "viewer" }] }],
    ["the same person twice", { access: [{ userId: "64b0000000000000000000a1", relation: "member" }, { userId: "64b0000000000000000000a1", relation: "owner" }] }],
  ])("refuses %s, and creates nothing", async (_label, extra) => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await POST(post({ name: "Bad", key: "BAD", ...extra }), ctx());

    expect(response.status).toBe(400);
    expect(projectCreate).not.toHaveBeenCalled();
    expect(grantCreate).not.toHaveBeenCalled();
  });

  it("still lets only an instance admin create a board", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await POST(post({ name: "Nope", key: "NOP", columns: SETUP_COLUMNS }), ctx());

    expect(response.status).toBe(403);
    expect(projectCreate).not.toHaveBeenCalled();
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
