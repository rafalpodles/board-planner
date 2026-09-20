import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));

const { POST, PUT, DELETE } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

interface Template {
  _id: { toString: () => string };
  name: string;
  title: string;
  description: string;
  category: string;
  acceptanceCriteria: string;
}

const template = (id: string, name: string): Template => ({
  _id: { toString: () => id },
  name,
  title: `${name} title`,
  description: "",
  category: "user-story",
  acceptanceCriteria: "",
});

/** The project as stored, with the templates it already holds. */
function project(...templates: Template[]) {
  const doc = { taskTemplates: templates, save: vi.fn(async () => {}) };
  projectFindById.mockResolvedValue(doc);
  return doc;
}

const names = (body: unknown) => (body as Template[]).map((t) => t.name);

function call(verb: typeof POST, body: unknown) {
  return verb(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/templates`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    ctx()
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  project(template("t1", "Crash report"));
});

describe("POST /api/projects/:projectId/templates", () => {
  it("adds a template and answers with the whole list", async () => {
    const res = await call(POST, { name: " Bug ", title: "Something broke" });

    expect(res.status).toBe(201);
    expect(names(await res.json())).toEqual(["Crash report", "Bug"]);
  });

  it("fills the fields the request left out", async () => {
    const doc = project();

    await call(POST, { name: "Bug" });

    expect(doc.taskTemplates[0]).toEqual({
      name: "Bug",
      title: "",
      description: "",
      category: "user-story",
      acceptanceCriteria: "",
    });
  });

  it("refuses a name that is missing, blank, or not a string", async () => {
    expect((await call(POST, {})).status).toBe(400);
    expect((await call(POST, { name: "   " })).status).toBe(400);
    expect((await call(POST, { name: 7 })).status).toBe(400);
  });

  // The picker offers templates by name, so two called the same thing are indistinguishable at
  // the only moment anybody chooses one.
  it("refuses a name an existing template already has, whatever its case", async () => {
    const res = await call(POST, { name: "crash REPORT" });

    expect(res.status).toBe(409);
  });

  it("404s when the project does not exist", async () => {
    projectFindById.mockResolvedValue(null);

    expect((await call(POST, { name: "Bug" })).status).toBe(404);
  });
});

describe("PUT /api/projects/:projectId/templates", () => {
  it("updates only the fields the request names", async () => {
    const doc = project(template("t1", "Crash report"));

    const res = await call(PUT, { templateId: "t1", title: "New title" });

    expect(res.status).toBe(200);
    expect(doc.taskTemplates[0].title).toBe("New title");
    expect(doc.taskTemplates[0].name).toBe("Crash report");
  });

  /**
   * The update loop walks a fixed list of fields, so anything else in the body is dropped rather
   * than written. `_id` is the one that matters: a template whose id could be rewritten would
   * detach from the audit trail and could be made to collide with another row's.
   */
  it("ignores a field that is not one of the five it allows", async () => {
    const doc = project(template("t1", "Crash report"));

    await call(PUT, { templateId: "t1", _id: "somethingElse", sneaky: true });

    expect(doc.taskTemplates[0]._id.toString()).toBe("t1");
    expect(doc.taskTemplates[0]).not.toHaveProperty("sneaky");
  });

  it("refuses a request that names no template", async () => {
    expect((await call(PUT, { title: "New title" })).status).toBe(400);
  });

  it("404s for a template id this project does not hold", async () => {
    expect((await call(PUT, { templateId: "nope", title: "x" })).status).toBe(404);
  });

  it("404s when the project does not exist", async () => {
    projectFindById.mockResolvedValue(null);

    expect((await call(PUT, { templateId: "t1", title: "x" })).status).toBe(404);
  });
});

describe("DELETE /api/projects/:projectId/templates", () => {
  it("removes the named template", async () => {
    project(template("t1", "Crash report"), template("t2", "Page"));

    const res = await call(DELETE, { templateId: "t1" });

    expect(res.status).toBe(200);
    expect(names(await res.json())).toEqual(["Page"]);
  });

  /**
   * A delete of something already gone still saves and still answers 200 — it is idempotent, and
   * two people closing the same row do not get an error. It logs nothing, though, because there
   * is no name to log and an audit row saying a template was removed twice would be a lie.
   */
  it("is idempotent, and records nothing when there was nothing to remove", async () => {
    const doc = project(template("t1", "Crash report"));

    const res = await call(DELETE, { templateId: "gone" });

    expect(res.status).toBe(200);
    expect(names(await res.json())).toEqual(["Crash report"]);
    expect(doc.save).toHaveBeenCalled();
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("refuses a request that names no template", async () => {
    expect((await call(DELETE, {})).status).toBe(400);
  });

  // Deleting is project-owner; adding and editing are project-access. A member may compose a
  // template for the board, but removing one takes it away from everybody.
  it("403s a member who may add and edit but not remove", async () => {
    check.mockImplementation(async (_user: unknown, _project: unknown, level: string) =>
      level === "access"
    );

    expect((await call(DELETE, { templateId: "t1" })).status).toBe(403);
    expect((await call(PUT, { templateId: "t1", title: "x" })).status).toBe(200);
  });
});

describe("the gates every verb sits behind", () => {
  it("401s with no credential", async () => {
    getAuthUser.mockResolvedValue(null);

    expect((await call(POST, { name: "Bug" })).status).toBe(401);
    expect((await call(PUT, { templateId: "t1", title: "x" })).status).toBe(401);
    expect((await call(DELETE, { templateId: "t1" })).status).toBe(401);
    expect(projectFindById).not.toHaveBeenCalled();
  });

  it("403s somebody with no access to the project", async () => {
    check.mockResolvedValue(false);

    expect((await call(POST, { name: "Bug" })).status).toBe(403);
    expect((await call(PUT, { templateId: "t1", title: "x" })).status).toBe(403);
    expect((await call(DELETE, { templateId: "t1" })).status).toBe(403);
    expect(projectFindById).not.toHaveBeenCalled();
  });
});
