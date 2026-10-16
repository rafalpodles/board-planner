import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import { hasSeveralRepositories, projectRepositories, withPrimaryUrl } from "./repositories";

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

describe("hasSeveralRepositories", () => {
  const entries = [
    { _id: new Types.ObjectId(), url: "https://github.com/acme/api", name: "API" },
    { _id: new Types.ObjectId(), url: "https://github.com/acme/web", name: "" },
  ];

  it("counts a project as having several only once it stores more than one", () => {
    expect(hasSeveralRepositories({ repositories: entries })).toBe(true);
    expect(hasSeveralRepositories({ repositories: [entries[0]] })).toBe(false);
    expect(hasSeveralRepositories({ repositoryUrl: "https://github.com/acme/api" })).toBe(false);
  });
});
