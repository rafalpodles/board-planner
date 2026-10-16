import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import {
  hasSeveralRepositories,
  projectRepositories,
  repositoryIdFor,
  repositoryNameOf,
  repositoryRefusal,
  withPrimaryUrl,
} from "./repositories";

const id = new Types.ObjectId();

describe("projectRepositories", () => {
  it("reads the stored list, first being the primary", () => {
    const second = new Types.ObjectId();
    expect(
      projectRepositories({
        repositoryUrl: "https://github.com/acme/web",
        repositories: [
          { _id: id, url: "https://github.com/acme/web", name: "Web" },
          { _id: second, url: " https://gitlab.com/acme/api ", name: "" },
        ],
      })
    ).toEqual([
      { id: String(id), url: "https://github.com/acme/web", name: "Web" },
      { id: String(second), url: "https://gitlab.com/acme/api", name: "" },
    ]);
  });

  it("derives the one repository of a project the migration has not reached", () => {
    expect(projectRepositories({ repositoryUrl: "git@github.com:acme/web.git" })).toEqual([
      { id: "primary", url: "git@github.com:acme/web.git", name: "" },
    ]);
    expect(projectRepositories({ githubRepo: "acme/web" })[0].url).toBe("https://github.com/acme/web");
    expect(projectRepositories({})).toEqual([]);
  });
});

describe("withPrimaryUrl", () => {
  it("moves the primary's address and keeps its id and name, so what names it still does", () => {
    const rest = { _id: new Types.ObjectId(), url: "https://gitlab.com/acme/api" };
    expect(withPrimaryUrl([{ _id: id, url: "https://github.com/acme/old", name: "Web" }, rest], " https://github.com/acme/new ")).toEqual([
      { _id: id, url: "https://github.com/acme/new", name: "Web" },
      rest,
    ]);
  });

  it("starts a list for a project with none, and an empty address leaves no primary", () => {
    const [made] = withPrimaryUrl(undefined, "https://github.com/acme/web");
    expect(made).toMatchObject({ url: "https://github.com/acme/web", name: "" });
    expect(made._id).toBeInstanceOf(Types.ObjectId);
    expect(withPrimaryUrl([{ _id: id, url: "https://github.com/acme/web" }], "  ")).toEqual([]);
  });
});

describe("naming a repository on a task (BP-1066)", () => {
  const api = new Types.ObjectId();
  const web = new Types.ObjectId();
  const project = {
    repositories: [
      { _id: api, url: "https://github.com/acme/api", name: "API" },
      { _id: web, url: "https://github.com/acme/web", name: "" },
    ],
  };

  describe("repositoryRefusal", () => {
    it("lets an entry of the list, or nothing, through", () => {
      expect(repositoryRefusal(project, String(api))).toBeNull();
      expect(repositoryRefusal(project, null)).toBeNull();
      expect(repositoryRefusal(project, "")).toBeNull();
      expect(repositoryRefusal(project, undefined)).toBeNull();
    });

    it("refuses an id the project does not list, naming the ones it does", () => {
      const reason = repositoryRefusal(project, String(new Types.ObjectId()));

      expect(reason).toContain(`${api} (API)`);
      expect(reason).toContain(`${web} (https://github.com/acme/web)`);
    });

    it("refuses the derived primary of an unmigrated project, which would dangle", () => {
      expect(repositoryRefusal({ repositoryUrl: "https://github.com/acme/api" }, "primary")).toMatch(/names no repository/);
    });

    it("bounds what it echoes", () => {
      expect(repositoryRefusal(project, "z".repeat(500))).not.toContain("z".repeat(65));
    });
  });

  describe("repositoryIdFor", () => {
    it("finds an entry by id, by name in any case, or by address", () => {
      expect(repositoryIdFor(project, String(web))).toEqual({ id: String(web) });
      expect(repositoryIdFor(project, "api")).toEqual({ id: String(api) });
      expect(repositoryIdFor(project, "https://GitHub.com/acme/web")).toEqual({ id: String(web) });
    });

    it("clears on an empty reference", () => {
      expect(repositoryIdFor(project, "  ")).toEqual({ id: null });
    });

    it("refuses a name two entries share, rather than picking the first", () => {
      const twins = { repositories: [{ _id: api, url: "https://a/x", name: "same" }, { _id: web, url: "https://a/y", name: "Same" }] };

      expect(repositoryIdFor(twins, "same")).toEqual({ error: expect.stringContaining("use an id") });
    });

    it("lists what exists when nothing matches", () => {
      expect(repositoryIdFor(project, "nope")).toEqual({ error: expect.stringContaining(String(web)) });
    });
  });

  it("counts a project as having several only once it stores more than one", () => {
    expect(hasSeveralRepositories(project)).toBe(true);
    expect(hasSeveralRepositories({ repositories: [project.repositories[0]] })).toBe(false);
    expect(hasSeveralRepositories({ repositoryUrl: "https://github.com/acme/api" })).toBe(false);
  });

  it("shows the name, else the address, else the bare id of a repository that is gone", () => {
    expect(repositoryNameOf(project, String(api))).toBe("API");
    expect(repositoryNameOf(project, String(web))).toBe("https://github.com/acme/web");
    expect(repositoryNameOf(project, "gone")).toBe("gone");
    expect(repositoryNameOf(project, null)).toBeNull();
  });
});
