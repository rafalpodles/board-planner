import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import {
  describeRepositoryChanges,
  hasSeveralRepositories,
  parseAdditionalRepositories,
  planRepositories,
  projectRepositories,
  withAdditionalRepositories,
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

describe("parseAdditionalRepositories", () => {
  const primary = "https://github.com/acme/web";

  it("trims, and keeps the order given", () => {
    expect(parseAdditionalRepositories([{ url: " https://github.com/acme/b ", name: " B " }, { url: "https://github.com/acme/a" }], primary)).toEqual({
      value: [
        { url: "https://github.com/acme/b", name: "B" },
        { url: "https://github.com/acme/a", name: "" },
      ],
    });
  });

  it("sees the same repository through every spelling of its address", () => {
    for (const same of ["git@github.com:acme/web.git", "https://github.com/ACME/web/", "ssh://git@github.com/acme/web"]) {
      expect(parseAdditionalRepositories([{ url: same }], primary)).toEqual({ error: expect.stringContaining("already listed") });
    }
  });

  it("allows nothing after a primary that does not exist, and an empty list without one", () => {
    expect(parseAdditionalRepositories([{ url: "https://github.com/acme/a" }], "  ")).toEqual({ error: expect.stringContaining("set the repository URL") });
    expect(parseAdditionalRepositories([], "")).toEqual({ value: [] });
  });
});

describe("withAdditionalRepositories", () => {
  it("builds the primary from the address when the project stored none yet", () => {
    const [first, second] = withAdditionalRepositories(undefined, "https://github.com/acme/web", [{ url: "https://github.com/acme/api", name: "" }]);
    expect(first).toMatchObject({ url: "https://github.com/acme/web" });
    expect(second).toMatchObject({ url: "https://github.com/acme/api" });
  });
});

describe("describeRepositoryChanges", () => {
  const entry = (url: string, name = "") => ({ _id: new Types.ObjectId(), url, name });
  const primary = entry("https://github.com/acme/web");

  it("says what was added, renamed and removed, and nothing of the primary", () => {
    const before = [primary, entry("https://github.com/acme/api", "API"), entry("https://github.com/acme/old")];
    const after = [entry("https://github.com/acme/moved"), entry("https://github.com/acme/api", "Backend"), entry("https://github.com/acme/new", "New")];
    expect(describeRepositoryChanges(before, after)).toEqual([
      'Renamed repository https://github.com/acme/api to "Backend"',
      "Added repository https://github.com/acme/new (New)",
      "Removed repository https://github.com/acme/old",
    ]);
  });

  it("says nothing when the entries after the primary are the same", () => {
    const list = [primary, entry("https://github.com/acme/api", "API")];
    expect(describeRepositoryChanges(list, list)).toEqual([]);
  });
});

describe("planRepositories", () => {
  const entry = (url: string, name = "") => ({ _id: new Types.ObjectId(), url, name });
  const web = entry("https://github.com/acme/web", "Web");
  const api = entry("https://github.com/acme/api", "API");

  it("moves the primary and keeps the others as they are", () => {
    const plan = planRepositories({ stored: [web, api], legacyPrimary: "", primary: "https://github.com/acme/web2" });
    expect(plan).toEqual({ repositories: [{ ...web, url: "https://github.com/acme/web2" }, api] });
  });

  it("refuses a primary that is one of the others, though the others are not sent", () => {
    expect(planRepositories({ stored: [web, api], legacyPrimary: "", primary: "git@github.com:acme/api.git" })).toEqual({
      error: expect.stringContaining("already listed"),
    });
  });

  it("clears everything in one request, and refuses to clear only the primary", () => {
    expect(planRepositories({ stored: [web, api], legacyPrimary: "", primary: "", additional: [] })).toEqual({ repositories: [] });
    expect(planRepositories({ stored: [web, api], legacyPrimary: "", primary: "" })).toEqual({
      error: expect.stringContaining("Remove the additional repositories"),
    });
    expect(planRepositories({ stored: [web, api], legacyPrimary: "", primary: "", additional: [{ url: "https://github.com/acme/api" }] })).toEqual({
      error: expect.stringContaining("set the repository URL"),
    });
  });

  it("gives a project that has not been migrated a stored primary from its legacy address", () => {
    const plan = planRepositories({ stored: [], legacyPrimary: "https://gitlab.example.com/acme/web", additional: [{ url: "https://github.com/acme/api" }] });
    expect(plan).toEqual({
      repositories: [
        expect.objectContaining({ url: "https://gitlab.example.com/acme/web" }),
        expect.objectContaining({ url: "https://github.com/acme/api" }),
      ],
    });
  });

  it("keeps an id only for the same host and path", () => {
    const sameHost = planRepositories({ stored: [web, api], legacyPrimary: "", additional: [{ url: "https://github.com/acme/api.git", name: "" }] });
    expect(sameHost).toMatchObject({ repositories: [web, { _id: api._id }] });
    const otherHost = planRepositories({ stored: [web, api], legacyPrimary: "", additional: [{ url: "https://git.example.com/acme/api", name: "" }] });
    expect("repositories" in otherHost && otherHost.repositories[1]._id).not.toEqual(api._id);
  });

  it("accepts the same path on two hosts as two repositories", () => {
    expect(parseAdditionalRepositories([{ url: "https://git.example.com/acme/web" }], "https://github.com/acme/web")).toEqual({
      value: [{ url: "https://git.example.com/acme/web", name: "" }],
    });
  });
});
