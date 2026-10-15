import { describe, it, expect } from "vitest";
import { MAX_IMPORT_TASKS, parseBundle, parseMapping } from "./bundle";

const task = (over: Record<string, unknown> = {}) => ({ id: "1", title: "t", ...over });

describe("parseBundle", () => {
  it("takes a source and a list of tasks", () => {
    expect(parseBundle({ source: " jira ", tasks: [task()] })).toEqual({ ok: true, value: { source: "jira", tasks: [task()] } });
  });

  it.each([
    [null, "The bundle must be an object"],
    [{ tasks: [] }, "source must be a name of 1 to 50 characters"],
    [{ source: "x", tasks: {} }, "tasks must be a list"],
    [{ source: "x", tasks: [task(), task()] }, 'tasks[1].id "1" appears twice'],
    [{ source: "x", tasks: [task({ id: "" })] }, "tasks[0].id must be a string of 1 to 200 characters"],
    [{ source: "x", tasks: [task({ title: 3 })] }, "tasks[0].title must be a string"],
    [{ source: "x", tasks: [task({ status: 1 })] }, "tasks[0].status must be a string"],
    [{ source: "x", tasks: [task({ fields: [] })] }, "tasks[0].fields must be an object"],
    [{ source: "x", tasks: [task({ comments: [{ id: "c", body: 1 }] })] }, "tasks[0].comments[0].body must be a string"],
    [{ source: "x", tasks: [task({ comments: [{ id: "c", body: "a" }, { id: "c", body: "b" }] })] }, "tasks[0].comments[1].id appears twice on its task"],
  ])("refuses %j before anything is written", (raw, error) => {
    expect(parseBundle(raw)).toEqual({ ok: false, error });
  });

  it("refuses more tasks than one import takes", () => {
    const tasks = Array.from({ length: MAX_IMPORT_TASKS + 1 }, (_, i) => task({ id: String(i) }));
    expect(parseBundle({ source: "x", tasks })).toMatchObject({ ok: false, error: "A bundle holds at most 5,000 tasks" });
  });
});

describe("parseMapping", () => {
  it("takes nothing as no mapping, and refuses a value that is not a name", () => {
    expect(parseMapping(undefined)).toEqual({ ok: true, value: {} });
    expect(parseMapping({ users: { a: null, b: "maya" } })).toMatchObject({ ok: true, value: { users: { a: null, b: "maya" } } });
    expect(parseMapping({ statuses: { a: 1 } })).toEqual({ ok: false, error: 'mapping.statuses["a"] must be a string' });
  });

  it("refuses a parent or blocker that is not an id, and more blockers than a task takes", () => {
    const long = "x".repeat(201);
    expect(parseBundle({ source: "s", tasks: [{ id: "1", title: "t", parent: long }] }).ok).toBe(false);
    expect(parseBundle({ source: "s", tasks: [{ id: "1", title: "t", blockedBy: [long] }] }).ok).toBe(false);
    expect(parseBundle({ source: "s", tasks: [{ id: "1", title: "t", blockedBy: Array.from({ length: 101 }, (_, i) => String(i)) }] }).ok).toBe(false);
    expect(parseBundle({ source: "s", tasks: [{ id: "1", title: "t", parent: "2", blockedBy: ["3"] }] }).ok).toBe(true);
  });
});
