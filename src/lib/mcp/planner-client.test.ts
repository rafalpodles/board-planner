import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlannerClient } from "./planner-client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestedUrl(): string {
  return fetchMock.mock.calls.at(-1)![0] as string;
}

const PROJECT = "507f1f77bcf86cd799439011";
const TASK = "507f1f77bcf86cd799439012";

// A tool argument becomes a path segment. The WHATWG parser normalises `..` away before the request
// leaves, so an argument could pick the route rather than name the resource (BP-316) — and the first
// fix, plain encodeURIComponent, escaped `/` while leaving dots alone, so the one input it was named
// after still went through (BP-339). It is an allowlist now: an ObjectId or a project key, nothing else.
describe("PlannerClient path building", () => {
  const client = new PlannerClient("https://board.example.com", "cp_token");

  it("builds an ordinary path unchanged", async () => {
    await client.getTask(PROJECT, TASK);

    expect(requestedUrl()).toBe(
      `https://board.example.com/api/projects/${PROJECT}/tasks/${TASK}`
    );
  });

  it("accepts a project key, which is what get_project is usually given", async () => {
    await client.getProject("BP");

    expect(new URL(requestedUrl()).pathname).toBe("/api/projects/BP");
  });

  it("keeps the query string a caller's filters build, separate from the path", async () => {
    await client.listTasks(PROJECT, { status: "todo&assignee=admin" });

    const url = new URL(requestedUrl());
    expect(url.pathname).toBe(`/api/projects/${PROJECT}/tasks`);
    expect(url.searchParams.get("status")).toBe("todo&assignee=admin");
    expect(url.searchParams.has("assignee")).toBe(false);
  });
});

// Every earlier test here used an argument containing slashes — which encodes, and goes green — so
// none of them could see that a bare ".." walked straight through (BP-339).
describe("a segment that could choose the path is refused, not encoded", () => {
  const client = new PlannerClient("https://board.example.com", "cp_token");

  const REFUSED: Array<[string, unknown]> = [
    ["climbs a level", ".."],
    ["names the current level", "."],
    ["is empty, collapsing the segment", ""],
    ["adds segments", "a/b"],
    ["climbs after adding one", "a/../b"],
    ["reaches for the instance root", "../../latest/meta-data"],
    ["looks like another host", "//attacker.example/x"],
    ["opens a query string", "p1?admin=1"],
    ["opens a fragment", "p1#x"],
    ["is a backslash form", "..\\.."],
    ["carries a newline", "p1\nx"],
    ["is percent-encoded", "%2e%2e"],
    // RegExp.test coerces, so an array whose String() is a dot segment would otherwise pass
    ["is not a string at all", [".."]],
    ["is an object that stringifies to one", { toString: () => ".." }],
  ];

  it.each(REFUSED)("refuses a value that %s", async (_why, value) => {
    await expect(client.getTask(value as string, TASK)).rejects.toThrow(/Invalid path segment/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses it in the second segment too, not only the first", async () => {
    await expect(client.getTask(PROJECT, "..")).rejects.toThrow(/Invalid path segment/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Only getProject/getTask/listTasks were covered before, so dropping the guard from the other
  // eight left the suite green — the mutation the BP-316 review ran
  it.each([
    ["getProject", (v: string) => client.getProject(v)],
    ["listTasks", (v: string) => client.listTasks(v)],
    ["createTask", (v: string) => client.createTask(v, {})],
    ["updateTask", (v: string) => client.updateTask(v, TASK, {})],
    ["changeTaskStatus", (v: string) => client.changeTaskStatus(v, TASK, "done")],
    ["listComments", (v: string) => client.listComments(v, TASK)],
    ["addComment", (v: string) => client.addComment(v, TASK, "hi")],
    ["listSprints", (v: string) => client.listSprints(v)],
    ["createSprint", (v: string) => client.createSprint(v, {})],
    ["updateSprint", (v: string) => client.updateSprint(v, "s1", {})],
  ])("%s refuses it as well", async (_name, call) => {
    await expect(call("..")).rejects.toThrow(/Invalid path segment/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The message names the value so the tool caller can see what it sent, and nothing else
  it("says which value was refused, without leaking the URL it would have built", async () => {
    const error = await client.getProject("..").catch((e: Error) => e);

    expect(String(error)).toContain('"..')
    expect(String(error)).not.toContain("board.example.com");
  });
});
