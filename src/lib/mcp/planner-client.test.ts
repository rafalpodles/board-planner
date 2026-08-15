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

// BP-316: tool arguments become path segments, and the WHATWG parser normalises `..` away — so a
// tool argument chose the path the server fetched rather than the resource it named.
describe("PlannerClient path building", () => {
  const client = new PlannerClient("https://board.example.com", "cp_token");

  it("encodes a traversal attempt instead of letting it climb", async () => {
    await client.getProject("../../latest/meta-data").catch(() => {});

    expect(requestedUrl()).toBe(
      "https://board.example.com/api/projects/..%2F..%2Flatest%2Fmeta-data"
    );
    expect(new URL(requestedUrl()).pathname).toBe("/api/projects/..%2F..%2Flatest%2Fmeta-data");
  });

  it("encodes every segment of a nested path", async () => {
    await client.getTask("p/1", "t?2").catch(() => {});

    expect(requestedUrl()).toBe("https://board.example.com/api/projects/p%2F1/tasks/t%3F2");
  });

  it("does not let a segment introduce a query string", async () => {
    await client.listTasks("p1?admin=1").catch(() => {});

    expect(new URL(requestedUrl()).searchParams.has("admin")).toBe(false);
  });

  it("still builds an ordinary path unchanged", async () => {
    await client.getTask("507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012").catch(() => {});

    expect(requestedUrl()).toBe(
      "https://board.example.com/api/projects/507f1f77bcf86cd799439011/tasks/507f1f77bcf86cd799439012"
    );
  });

  it("keeps the configured base URL, whatever the argument says", async () => {
    await client.getProject("//attacker.example/x").catch(() => {});

    expect(new URL(requestedUrl()).origin).toBe("https://board.example.com");
  });
});

// Encoding escapes `/` and leaves dots alone, so the one input the guard is named after went
// straight through. Every test above uses an argument containing slashes — which encodes, and goes
// green — so none of them could see it (BP-339).
describe("a segment that would climb out of the path is refused, not encoded", () => {
  const client = new PlannerClient("https://board.example.com", "cp_token");

  it.each(["..", ".", ""])("refuses %o rather than fetching something else", async (value) => {
    await expect(client.getTask(value, "t1")).rejects.toThrow(/Invalid path segment/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // What it did before: the projects/<id> segment vanished and the request landed on a sibling
  // route the tool never named, losing the per-project scoping with it
  it("does not turn getTask(\"..\") into a request for /api/tasks", async () => {
    await client.getTask("..", "t1").catch(() => {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the climb in the second segment too", async () => {
    await expect(client.getTask("p1", "..")).rejects.toThrow(/Invalid path segment/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["listTasks", (v: string) => client.listTasks(v)],
    ["createTask", (v: string) => client.createTask(v, {})],
    ["changeTaskStatus", (v: string) => client.changeTaskStatus(v, "t1", "done")],
    ["listComments", (v: string) => client.listComments(v, "t1")],
    ["addComment", (v: string) => client.addComment(v, "t1", "hi")],
    ["listSprints", (v: string) => client.listSprints(v)],
    ["createSprint", (v: string) => client.createSprint(v, {})],
    ["updateSprint", (v: string) => client.updateSprint(v, "s1", {})],
    ["updateTask", (v: string) => client.updateTask(v, "t1", {})],
    ["getProject", (v: string) => client.getProject(v)],
  ])("%s refuses it as well", async (_name, call) => {
    await expect(call("..")).rejects.toThrow(/Invalid path segment/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A dot is only special when it is the whole segment — these are ordinary, if odd, identifiers
  it.each(["...", "..a", "a..", ".hidden", "%2e%2e"])("still accepts %o", async (value) => {
    await client.getProject(value).catch(() => {});

    expect(fetchMock).toHaveBeenCalled();
    expect(new URL(requestedUrl()).pathname.startsWith("/api/projects/")).toBe(true);
  });
});

// Only getProject/getTask/listTasks were covered, so removing seg() from the other eight left the
// suite green — the mutation the BP-316 review ran (see [[security-fix-needs-review-of-the-result]])
describe("every method that takes an id encodes it", () => {
  const client = new PlannerClient("https://board.example.com", "cp_token");
  const HOSTILE = "a/../b";
  const ENCODED = "a%2F..%2Fb";

  const calls: Array<[string, () => Promise<unknown>]> = [
    ["getProject", () => client.getProject(HOSTILE)],
    ["listTasks", () => client.listTasks(HOSTILE)],
    ["getTask", () => client.getTask(HOSTILE, HOSTILE)],
    ["createTask", () => client.createTask(HOSTILE, {})],
    ["updateTask", () => client.updateTask(HOSTILE, HOSTILE, {})],
    ["changeTaskStatus", () => client.changeTaskStatus(HOSTILE, HOSTILE, "done")],
    ["listComments", () => client.listComments(HOSTILE, HOSTILE)],
    ["addComment", () => client.addComment(HOSTILE, HOSTILE, "hi")],
    ["listSprints", () => client.listSprints(HOSTILE)],
    ["createSprint", () => client.createSprint(HOSTILE, {})],
    ["updateSprint", () => client.updateSprint(HOSTILE, HOSTILE, {})],
  ];

  it.each(calls)("%s", async (_name, call) => {
    await call().catch(() => {});

    const url = requestedUrl();
    expect(url).toContain(ENCODED);
    expect(new URL(url).pathname).not.toContain("/b");
  });
});
