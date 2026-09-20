import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MAX_TASK_TEMPLATES,
  TASK_TITLE_MAX_LENGTH,
  TEMPLATE_NAME_MAX_LENGTH,
} from "@/lib/identifiers";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findById: projectFindById, findOneAndUpdate: projectFindOneAndUpdate },
}));
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
  // The add is an atomic $push whose filter carries the ceiling; the stub applies it the way the
  // database would, refusal included.
  projectFindOneAndUpdate.mockImplementation(
    async (filter: Record<string, unknown>, update: { $push: { taskTemplates: Template } }) => {
      const full = doc.taskTemplates.length >= Number(MAX_TASK_TEMPLATES);
      if (`taskTemplates.${MAX_TASK_TEMPLATES - 1}` in filter && full) return null;
      doc.taskTemplates = [...doc.taskTemplates, update.$push.taskTemplates];
      return doc;
    }
  );
  return doc;
}

/** `count` templates, named apart so a duplicate check cannot be what refuses a request. */
const many = (count: number) =>
  Array.from({ length: count }, (_, i) => template(`t${i}`, `Template ${i}`));

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

  it("records the addition on the project's audit log, under the trimmed name", async () => {
    await call(POST, { name: "  Bug  " });

    expect(logProjectAudit).toHaveBeenCalledWith(PROJECT_ID, "u1", "template_added", "Bug");
  });

  /**
   * BP-716. Neither this list nor the category list was in BP-323's sweep, and both are read on
   * every board load.
   */
  it(`refuses the ${MAX_TASK_TEMPLATES + 1}th template, and still adds the ${MAX_TASK_TEMPLATES}th`, async () => {
    project(...many(MAX_TASK_TEMPLATES));

    const refused = await call(POST, { name: "one too many" });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: `A project may have at most ${MAX_TASK_TEMPLATES} templates`,
    });

    project(...many(MAX_TASK_TEMPLATES - 1));
    expect((await call(POST, { name: "the last one" })).status).toBe(201);
  });

  it("carries the ceiling in the write filter rather than checking it beforehand", async () => {
    await call(POST, { name: "Bug" });

    expect(projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT_ID, [`taskTemplates.${MAX_TASK_TEMPLATES - 1}`]: { $exists: false } },
      { $push: { taskTemplates: expect.objectContaining({ name: "Bug" }) } },
      { returnDocument: "after" }
    );
  });

  /**
   * A template is copied into a task, so anything looser here is the long way round to the limit
   * the task route enforces. The schema had `default: ""` and no bound at all.
   */
  it.each([
    ["a name past its limit", { name: "x".repeat(TEMPLATE_NAME_MAX_LENGTH + 1) }],
    ["a title past a task's own limit", { name: "Bug", title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1) }],
    ["a non-string title", { name: "Bug", title: 7 }],
    ["a non-string description", { name: "Bug", description: [] }],
  ])("refuses %s", async (_name, body) => {
    expect((await call(POST, body)).status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
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

  /**
   * BP-716. The update used to walk a field list and assign whatever the body held, so a rename
   * could store a name that `POST` answers 400 or 409 for. A template is offered by name: a
   * duplicate is indistinguishable at the only moment anybody picks one, and a blank name is a
   * row that cannot be picked at all.
   */
  describe("the rules it now shares with POST", () => {
    beforeEach(() => {
      project(template("t1", "Crash report"), template("t2", "Page"));
    });

    it.each([
      ["blank", ""],
      ["only whitespace", "   "],
    ])("refuses a rename to a %s name", async (_name, value) => {
      const doc = project(template("t1", "Crash report"));

      expect((await call(PUT, { templateId: "t1", name: value })).status).toBe(400);
      expect(doc.taskTemplates[0].name).toBe("Crash report");
    });

    it("refuses a rename onto a name another template holds, whatever its case", async () => {
      const res = await call(PUT, { templateId: "t1", name: "PAGE" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Template with this name already exists" });
    });

    // Its own name is not a collision with itself — a recase or a retitle has to stay possible.
    it("allows a template to keep, recase or trim its own name", async () => {
      const doc = project(template("t1", "Crash report"));

      expect((await call(PUT, { templateId: "t1", name: "  CRASH Report  " })).status).toBe(200);
      expect(doc.taskTemplates[0].name).toBe("CRASH Report");
    });

    it("refuses a non-string name, which used to be written straight through", async () => {
      const doc = project(template("t1", "Crash report"));

      expect((await call(PUT, { templateId: "t1", name: 7 })).status).toBe(400);
      expect(doc.taskTemplates[0].name).toBe("Crash report");
    });

    it("refuses text past a task's own limits", async () => {
      expect(
        (await call(PUT, { templateId: "t1", title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1) })).status
      ).toBe(400);
      expect(
        (await call(PUT, { templateId: "t1", name: "x".repeat(TEMPLATE_NAME_MAX_LENGTH + 1) }))
          .status
      ).toBe(400);
    });

    // The control: a request that breaks none of the rules still goes through.
    it("still updates a template the ordinary way", async () => {
      const doc = project(template("t1", "Crash report"));

      expect((await call(PUT, { templateId: "t1", name: "Defect", title: "Broke" })).status).toBe(
        200
      );
      expect(doc.taskTemplates[0]).toMatchObject({ name: "Defect", title: "Broke" });
    });
  });
});

describe("DELETE /api/projects/:projectId/templates", () => {
  it("removes the named template", async () => {
    project(template("t1", "Crash report"), template("t2", "Page"));

    const res = await call(DELETE, { templateId: "t1" });

    expect(res.status).toBe(200);
    expect(names(await res.json())).toEqual(["Page"]);
  });

  it("records the removal on the project's audit log", async () => {
    project(template("t1", "Crash report"));

    await call(DELETE, { templateId: "t1" });

    expect(logProjectAudit).toHaveBeenCalledWith(
      PROJECT_ID,
      "u1",
      "template_removed",
      "Crash report"
    );
  });

  /**
   * A delete of something already gone still saves and still answers 200 — it is idempotent, and
   * two people closing the same row do not get an error. It logs nothing, though, because there
   * is no name to log and an audit row saying a template was removed twice would be a lie.
   *
   * The test above is this one's control: without it, deleting the audit call outright would
   * satisfy the negative assertion here and nothing else in the file would notice.
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
