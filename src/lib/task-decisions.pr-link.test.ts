import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { prUrlNamesProjectRepo } = await import("./task-decisions");

// BP-1066. Whether a pull request a machine reported is a link is judged against the project as this
// function read it, so the read has to include the repositories or only the primary one counts.
describe("prUrlNamesProjectRepo, as the decision panel asks it", () => {
  const project = {
    _id: "p1",
    repositoryUrl: "https://github.com/acme/api",
    repositories: [
      { _id: "r-api", url: "https://github.com/acme/api" },
      { _id: "r-web", url: "https://github.com/acme/web" },
    ],
  };
  // Honours the projection, so a field the function forgets to select is absent here too
  const db = {
    Project: {
      findById: () => ({
        select: (fields: string) => ({
          lean: async () => {
            const keep = new Set(fields.split(/\s+/));
            return Object.fromEntries(Object.entries(project).filter(([key]) => keep.has(key)));
          },
        }),
      }),
    },
  } as never;

  it("takes a pull request on a repository other than the primary as the project's own", async () => {
    expect(await prUrlNamesProjectRepo(db, "https://github.com/acme/web/pull/3", "p1")).toBe(true);
  });

  it("still refuses one on a repository the project does not list", async () => {
    expect(await prUrlNamesProjectRepo(db, "https://github.com/acme/other/pull/3", "p1")).toBe(false);
  });
});
