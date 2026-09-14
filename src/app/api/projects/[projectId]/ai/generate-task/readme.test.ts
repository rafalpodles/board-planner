import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/middleware", () => ({ withProjectAccess: (h: unknown) => h }));
vi.mock("@/models/project", () => ({ Project: { findById: vi.fn() } }));
vi.mock("@/models/task", () => ({ Task: { find: vi.fn() } }));
vi.mock("@/models/settings", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/ai", () => ({ isAIEnabled: () => true, generateTask: vi.fn() }));
vi.mock("@/lib/ai-fields", () => ({
  choiceFieldsForPrompt: vi.fn(),
  resolveGeneratedFields: vi.fn(),
}));

const { fetchReadme } = await import("./route");

/**
 * The README is read off raw.githubusercontent.com, which serves github.com and nothing else.
 * Before BP-634 this path was unreachable for a corporate host — `repositoryProvider` answered
 * `""` and the caller passed an empty string — and teaching the classifier that host made it
 * reachable. What went out was the internal hostname and a private repository's path, inside a
 * url GitHub could only 404 (found in review).
 */
describe("fetchReadme", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# Board", { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks nobody about a repository that is not on github.com", async () => {
    expect(await fetchReadme("https://ghe.corp.example/acme/board")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still reads one that is", async () => {
    expect(await fetchReadme("https://github.com/acme/board")).toBe("# Board");
    expect(fetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/acme/board/main/README.md",
      expect.anything()
    );
  });

  // The legacy shape, which carries no host at all and has always been read as GitHub's
  it("still reads a bare owner/repo", async () => {
    expect(await fetchReadme("acme/board")).toBe("# Board");
  });

  /**
   * An ssh remote hides the host from a `https?://` test, so the guard above let it through and
   * the whole string — `git@github.com:o/r` — was pasted into the raw.githubusercontent path.
   * Found by printing what the function does for each spelling rather than by reading it.
   */
  it("reads an ssh remote as the repository it names, not as a path", async () => {
    expect(await fetchReadme("git@github.com:acme/board.git")).toBe("# Board");
    expect(fetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/acme/board/main/README.md",
      expect.anything()
    );
  });

  it("asks nobody about an ssh remote somewhere else", async () => {
    expect(await fetchReadme("git@ghe.corp.example:acme/board.git")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  // A per-account ssh alias resolves only on the machine that has it, so there is no host to
  // judge — the same assumption a bare owner/repo has always been given
  it("still reads a per-account ssh alias as GitHub's", async () => {
    expect(await fetchReadme("git@github-work:acme/board.git")).toBe("# Board");
  });

  // raw.githubusercontent serves a path, and a lower-cased path is a different one
  it("keeps the case of the repository it was given", async () => {
    await fetchReadme("https://github.com/Acme/Board");
    expect(fetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/Acme/Board/main/README.md",
      expect.anything()
    );
  });

  /**
   * The spellings two earlier attempts at this guard each missed, and three reviewers found
   * independently. `repositoryUrl` is a free-form string with no format validation, and
   * `repositoryProvider` reads the host out of every one of these — so each reaches this function
   * on a GitHub Enterprise instance, and each used to be pasted into the raw.githubusercontent
   * path whole, corporate hostname and private path included.
   */
  it.each([
    "ssh://git@ghe.corp.example/acme/private.git",
    "git+ssh://git@ghe.corp.example/acme/private",
    "git://ghe.corp.example/acme/private",
    "git@ghe.corp.example:acme/private.git",
    "https://ghe.corp.example/acme/private",
  ])("asks nobody about %s", async (spelling) => {
    expect(await fetchReadme(spelling)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  // The same spellings on GitHub's own host still read, which is the control: a guard that
  // refused everything would pass the block above
  it.each([
    "ssh://git@github.com/acme/board.git",
    "https://www.github.com/acme/board",
    "https://token@github.com/acme/board",
    "https://github.com:443/acme/board",
  ])("still reads %s", async (spelling) => {
    expect(await fetchReadme(spelling)).toBe("# Board");
    expect(fetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/acme/board/main/README.md",
      expect.anything()
    );
  });

  it("asks nobody when the project names no repository", async () => {
    expect(await fetchReadme("")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
