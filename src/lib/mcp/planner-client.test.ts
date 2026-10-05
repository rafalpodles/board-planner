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
    ["editComment (project)", (v: string) => client.editComment(v, TASK, "c1", "x")],
    ["editComment (task)", (v: string) => client.editComment(PROJECT, v, "c1", "x")],
    ["editComment (comment)", (v: string) => client.editComment(PROJECT, TASK, v, "x")],
    ["deleteComment (project)", (v: string) => client.deleteComment(v, TASK, "c1")],
    ["deleteComment (task)", (v: string) => client.deleteComment(PROJECT, v, "c1")],
    ["deleteComment (comment)", (v: string) => client.deleteComment(PROJECT, TASK, v)],
    ["getTaskActivity (project)", (v: string) => client.getTaskActivity(v, TASK)],
    ["getTaskActivity (task)", (v: string) => client.getTaskActivity(PROJECT, v)],
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

/**
 * BP-564. `resolveTaskKey` refuses a badly-shaped key by quoting it, and that refusal is handed to
 * a model as a tool result — so the caller cannot choose its length.
 */
describe("what resolveTaskKey quotes back", () => {
  it("bounds a key a caller made enormous", async () => {
    const client = new PlannerClient("http://localhost", "cp_x");

    await expect(client.resolveTaskKey(`${"z".repeat(50_000)}!`)).rejects.toThrow(
      /Invalid task key: "z{64}…"/
    );
  });

  it("quotes a key anybody would really mistype in full", async () => {
    const client = new PlannerClient("http://localhost", "cp_x");

    await expect(client.resolveTaskKey("BP1")).rejects.toThrow('Invalid task key: "BP1"');
  });
});

/**
 * BP-904. Every key-addressed tool resolves its key here. It used to download the board's whole
 * task list and scan it for the number — ~400 KB per call on a board the size of BP — and it only
 * parsed keys made of letters, so a board keyed BP2, MY_APP or MY-APP was unreachable.
 */
describe("resolveTaskKey", () => {
  const PROJECT_ID = "507f1f77bcf86cd7994390aa";
  const TASK_ID = "507f1f77bcf86cd7994390bb";
  const client = new PlannerClient("https://board.example.com", "cp_token");
  const BOARDS = ["BP", "BP2", "MY_APP", "MY-APP", "NOPE"];
  const idOf = (key: string) => `${PROJECT_ID.slice(0, -2)}${BOARDS.indexOf(key).toString(16).padStart(2, "0")}`;

  /** The projects list names the boards, each with its own id; a task lookup answers with `tasks`. */
  function board(keys: string[], tasks: unknown[] = [{ _id: TASK_ID, taskNumber: 7 }]) {
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      const body =
        path === "/api/projects" ? keys.map((key) => ({ _id: idOf(key), key })) : tasks;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  const requested = () => fetchMock.mock.calls.map(([url]) => new URL(url as string));

  it.each([
    ["BP-7", "BP"],
    ["BP2-7", "BP2"],
    ["MY_APP-7", "MY_APP"],
    ["MY-APP-7", "MY-APP"],
    ["my-app-7", "MY-APP"],
  ])("resolves %s on the board %s", async (key, boardKey) => {
    board(["BP", "BP2", "MY_APP", "MY-APP"]);

    await expect(client.resolveTaskKey(key)).resolves.toEqual({ projectId: idOf(boardKey), taskId: TASK_ID });
  });

  // A server that predates the filter ignores it and answers with the whole board, so the first row
  // is whichever task is on top — and an update would land on it, silently
  it("does not take the first row of an answer that ignored the filter", async () => {
    board(["BP"], [{ _id: "507f1f77bcf86cd7994390cc", taskNumber: 3 }, { _id: TASK_ID, taskNumber: 7 }]);

    await expect(client.resolveTaskKey("BP-7")).resolves.toMatchObject({ taskId: TASK_ID });
  });

  it("says not found when an answer that ignored the filter does not hold the number", async () => {
    board(["BP"], [{ _id: "507f1f77bcf86cd7994390cc", taskNumber: 3 }]);

    await expect(client.resolveTaskKey("BP-7")).rejects.toThrow("Task BP-7 not found");
  });

  it("asks the server for the one number, and never for the board's task list", async () => {
    board(["MY-APP"]);

    await client.resolveTaskKey("MY-APP-7");

    const taskReads = requested().filter((url) => url.pathname.endsWith("/tasks"));
    expect(taskReads).toHaveLength(1);
    expect(taskReads[0].searchParams.get("taskNumber")).toBe("7");
  });

  it("says a number the board does not hold is not found", async () => {
    board(["BP"], []);

    await expect(client.resolveTaskKey("BP-999")).rejects.toThrow("Task BP-999 not found");
  });

  it.each(["BP-0", "BP-1000000000", `BP-${"9".repeat(40)}`])(
    "says %s is not found without asking the server for a task",
    async (key) => {
      board(["BP"]);

      await expect(client.resolveTaskKey(key)).rejects.toThrow(/not found/);
      expect(requested().filter((url) => url.pathname.endsWith("/tasks"))).toEqual([]);
    }
  );

  it("says a board that is not there is not there", async () => {
    board(["BP"]);

    await expect(client.resolveTaskKey("NOPE-1")).rejects.toThrow('Project with key "NOPE" not found');
  });

  it.each(["BP", "BP7", "-7", "BP-", "1BP-7", "MY APP-7", "A".repeat(21) + "-7", "BP-7a", "BP/..-7"])(
    "refuses %s as a malformed key, before asking anything",
    async (key) => {
      board(["BP"]);

      await expect(client.resolveTaskKey(key)).rejects.toThrow(/Invalid task key/);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

/**
 * BP-909. A batch looks the same things up for every item. A client lives for one tool call, so what it
 * has already asked it remembers — and forgets what the call itself changed.
 */
describe("the lookups one call repeats", () => {
  let client: PlannerClient;
  const paths = () => fetchMock.mock.calls.map(([url]) => new URL(url as string).pathname);

  beforeEach(() => {
    client = new PlannerClient("https://board.example.com", "cp_token");
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify([{ _id: "p1", key: "BP" }]), { status: 200, headers: { "content-type": "application/json" } })
    );
  });

  it("asks for the board list, a roster and the sprints once however often they are read", async () => {
    await Promise.all([client.listProjects(), client.listProjects(), client.getProjectByKey("BP")]);
    await client.listAssignableUsers("p1");
    await client.listAssignableUsers("p1");
    await client.listSprints("p1");
    await client.listSprints("p1");

    expect(paths()).toEqual(["/api/projects", "/api/projects/p1/assignable-users", "/api/projects/p1/sprints"]);
  });

  it("keeps each board's roster and sprints apart", async () => {
    await client.listSprints("p1");
    await client.listSprints("p2");

    expect(paths()).toEqual(["/api/projects/p1/sprints", "/api/projects/p2/sprints"]);
  });

  it("forgets a board's sprints when the call itself changes them", async () => {
    await client.listSprints("p1");
    await client.createSprint("p1", { name: "S" });
    await client.listSprints("p1");
    await client.updateSprint("p1", "s1", { goal: "g" });
    await client.listSprints("p1");
    await client.deleteSprint("p1", "s1");
    await client.listSprints("p1");

    expect(paths().filter((p) => p.endsWith("/sprints") ).length).toBe(5);
  });

  it("does not remember a lookup that failed", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));

    await expect(client.listProjects()).rejects.toThrow("network");
    await expect(client.listProjects()).resolves.toHaveLength(1);
  });

  it("is made once per call, not once per tool inside it", async () => {
    // The memo above only helps a batch if the tools it runs share the client
    const { clientFrom } = await import("./tools");
    const extra = { authInfo: { token: "cp_x", extra: { baseUrl: "https://board.example.com" } } } as never;

    expect(clientFrom(extra)).toBe(clientFrom(extra));
    expect(clientFrom({ ...(extra as object) } as never)).not.toBe(clientFrom(extra));
  });
});
