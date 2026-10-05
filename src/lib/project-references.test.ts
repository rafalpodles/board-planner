import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const calls: { model: string; op: string; filter: unknown; update?: unknown }[] = [];

function model(name: string) {
  return {
    deleteMany: vi.fn(async (filter: unknown) => {
      calls.push({ model: name, op: "deleteMany", filter });
      return { deletedCount: 0 };
    }),
    updateMany: vi.fn(async (filter: unknown, update: unknown) => {
      calls.push({ model: name, op: "updateMany", filter, update });
      return { modifiedCount: 0 };
    }),
  };
}

vi.mock("@/models/apiToken", () => ({ ApiToken: model("ApiToken") }));
vi.mock("@/models/oauthToken", () => ({ OAuthToken: model("OAuthToken") }));
vi.mock("@/models/oauthCode", () => ({ OAuthCode: model("OAuthCode") }));
vi.mock("@/models/worker", () => ({ Worker: model("Worker") }));
vi.mock("@/models/user", () => ({ User: model("User") }));
vi.mock("@/models/pmTrigger", () => ({ PmTrigger: model("PmTrigger") }));
vi.mock("@/models/pmOauthState", () => ({ PmOauthState: model("PmOauthState") }));
vi.mock("@/models/agent", () => ({ Agent: model("Agent") }));

const { dropProjectReferences, scopedOnlyTo, scopedToItAndAnother } = await import(
  "./project-references"
);
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");
const organisation = DEFAULT_ORGANISATION_ID;

const PROJECT = new Types.ObjectId("6a70afff45d39cd9bc8bb511");

beforeEach(() => {
  calls.length = 0;
});

const on = (name: string, op: string) => calls.filter((c) => c.model === name && c.op === op);

describe("dropProjectReferences", () => {
  it.each(["ApiToken", "OAuthToken", "OAuthCode"])(
    "revokes a %s scoped to nothing but the project",
    async (name) => {
      await dropProjectReferences(scopedToDefaultOrganisation(), PROJECT);

      expect(on(name, "deleteMany")).toEqual([
        { model: name, op: "deleteMany", filter: { ...scopedOnlyTo(PROJECT), organisation } },
      ]);
    }
  );

  it.each(["ApiToken", "OAuthToken", "OAuthCode"])(
    "pulls the project from a %s only where another project stays in scope",
    async (name) => {
      await dropProjectReferences(scopedToDefaultOrganisation(), PROJECT);

      expect(on(name, "updateMany")).toEqual([
        {
          model: name,
          op: "updateMany",
          filter: { ...scopedToItAndAnother(PROJECT), organisation },
          update: { $pull: { allowedProjects: PROJECT } },
        },
      ]);
    }
  );

  it.each(["ApiToken", "OAuthToken", "OAuthCode"])(
    "revokes the %s rows before narrowing the rest",
    async (name) => {
      await dropProjectReferences(scopedToDefaultOrganisation(), PROJECT);

      const ops = calls.filter((c) => c.model === name).map((c) => c.op);
      expect(ops).toEqual(["deleteMany", "updateMany"]);
    }
  );

  it("pulls the project from a machine's picked projects", async () => {
    await dropProjectReferences(scopedToDefaultOrganisation(), PROJECT);

    expect(on("Worker", "updateMany")).toEqual([
      {
        model: "Worker",
        op: "updateMany",
        filter: { desiredProjects: PROJECT, organisation },
        update: { $pull: { desiredProjects: PROJECT } },
      },
    ]);
  });

  it("drops every user's notification override for the project", async () => {
    await dropProjectReferences(scopedToDefaultOrganisation(), PROJECT);

    expect(on("User", "updateMany")).toEqual([
      {
        model: "User",
        op: "updateMany",
        filter: { "notifications.projects.project": PROJECT, organisation },
        update: { $pull: { "notifications.projects": { project: PROJECT } } },
      },
    ]);
  });

  it("deletes the project's PM triggers and pending MCP authorizations", async () => {
    await dropProjectReferences(scopedToDefaultOrganisation(), PROJECT);

    expect(on("PmTrigger", "deleteMany")).toEqual([
      { model: "PmTrigger", op: "deleteMany", filter: { project: PROJECT, organisation } },
    ]);
    expect(on("PmOauthState", "deleteMany")).toEqual([
      { model: "PmOauthState", op: "deleteMany", filter: { project: PROJECT, organisation } },
    ]);
  });

  it("deletes the project's own agents and no personal or global one", async () => {
    await dropProjectReferences(scopedToDefaultOrganisation(), PROJECT);

    expect(on("Agent", "deleteMany")).toEqual([
      { model: "Agent", op: "deleteMany", filter: { scope: "project", project: PROJECT, organisation } },
    ]);
  });
});

describe("the scope filters", () => {
  it("never pulls from a credential whose only project is this one", () => {
    expect(scopedToItAndAnother(PROJECT)).toEqual({
      $and: [{ allowedProjects: PROJECT }, { allowedProjects: { $elemMatch: { $ne: PROJECT } } }],
    });
  });

  it("revokes only a credential with no other project in scope", () => {
    expect(scopedOnlyTo(PROJECT)).toEqual({
      $and: [
        { allowedProjects: PROJECT },
        { allowedProjects: { $not: { $elemMatch: { $ne: PROJECT } } } },
      ],
    });
  });
});
