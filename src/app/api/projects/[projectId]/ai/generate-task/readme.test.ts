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

  it("asks nobody when the project names no repository", async () => {
    expect(await fetchReadme("")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
