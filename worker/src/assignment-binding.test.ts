import { describe, it, expect, vi } from "vitest";
import { bindAssignment, repositoriesOf, type BindOne } from "./assignment-binding.js";
import type { Assignment } from "./config.js";

const API = "git@github.com:acme/api.git";
const WEB = "git@github.com:acme/web.git";
const inventory = [
  { remote: API, path: "/repos/api" },
  { remote: WEB, path: "/repos/web" },
];
const binds: BindOne = async (path) => ({ ok: true, path, worktreeRoot: `${path}-worktrees` });

const several: Assignment = {
  project: "p1",
  remote: API,
  repositories: [
    { id: "r-api", name: "api", remote: API },
    { id: "r-web", name: "web", remote: WEB },
  ],
};

describe("repositoriesOf", () => {
  it("is the list the server sent, or the single remote of an assignment that predates one", () => {
    expect(repositoriesOf(several)).toHaveLength(2);
    expect(repositoriesOf({ project: "p1", remote: API })).toEqual([{ id: "", name: "", remote: API }]);
  });
});

describe("bindAssignment", () => {
  it("binds every repository, the first being the primary, each to its own checkout", async () => {
    const result = await bindAssignment(several, inventory, binds);

    expect(result).toEqual({
      ok: true,
      repositories: [
        { id: "r-api", name: "api", remote: API, path: "/repos/api", worktreeRoot: "/repos/api-worktrees" },
        { id: "r-web", name: "web", remote: WEB, path: "/repos/web", worktreeRoot: "/repos/web-worktrees" },
      ],
    });
  });

  it("binds an assignment with one remote as it always did, with no repository in the reason", async () => {
    const result = await bindAssignment({ project: "p1", remote: API }, inventory, binds);

    expect(result).toMatchObject({ ok: true, repositories: [{ remote: API, path: "/repos/api", name: API }] });
    expect(await bindAssignment({ project: "p1", remote: "git@github.com:x/y.git" }, inventory, binds)).toEqual({
      ok: false,
      reason: "no checkout of git@github.com:x/y.git on this machine",
    });
  });

  it("binds none when one repository has no checkout here, leading with the sentence the app matches on", async () => {
    const result = await bindAssignment(several, [inventory[0]], binds);

    expect(result).toEqual({ ok: false, reason: `no checkout of ${WEB} on this machine (repository web)` });
  });

  it("binds none when one checkout is refused, with its own reason", async () => {
    const refusing: BindOne = async (path) =>
      path === "/repos/web" ? { ok: false, reason: "/repos/web is not approved on this machine" } : binds(path);

    expect(await bindAssignment(several, inventory, refusing)).toEqual({
      ok: false,
      reason: "/repos/web is not approved on this machine (repository web)",
    });
  });

  it("stops at the first failure and binds nothing after it", async () => {
    const bind = vi.fn(binds);

    await bindAssignment(several, [inventory[1]], bind);

    expect(bind).not.toHaveBeenCalled();
  });

  // The path bound is what counts, not the one the inventory proposed: a symlink resolves to the same
  it("refuses two repositories that resolve to one checkout, rather than running two worktrees in it", async () => {
    const sameDirectory: BindOne = async () => ({ ok: true, path: "/repos/api", worktreeRoot: "/repos/api-worktrees" });

    const result = await bindAssignment(several, inventory, sameDirectory);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("are the same checkout") });
  });
});
