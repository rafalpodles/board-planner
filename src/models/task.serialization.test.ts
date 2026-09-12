import { describe, it, expect } from "vitest";
import { Task } from "./task";

// customFieldValues is a Map. JSON.stringify(new Map([["a", 1]])) is "{}", so
// without flattenMaps every custom field value is absent from every API response
// — which is how the feature shipped, and why nobody could use it.
describe("Task serialization", () => {
  it("flattens maps, or custom field values never reach the client", () => {
    expect(Task.schema.get("toJSON")).toMatchObject({ flattenMaps: true });
    expect(Task.schema.get("toObject")).toMatchObject({ flattenMaps: true });
  });

  // toJSON already flattens by default in this Mongoose version; toObject does not,
  // and a Map that reaches JSON.stringify as a Map serializes to {}
  it("round-trips a custom field value through toObject", () => {
    const doc = new Task({
      project: "6a69903ec4c79d7d07a5eda8",
      taskNumber: 1,
      title: "t",
      createdBy: "69a52cb3399b27d3cbb2c59b",
      customFieldValues: { fieldA: "kept" },
    });

    expect(JSON.parse(JSON.stringify(doc.toObject().customFieldValues))).toEqual({
      fieldA: "kept",
    });
  });
});

// task-service.test.ts mocks this model entirely, so nothing there exercises the real schema —
// this is the only thing that would notice assignedBy going missing
describe("Task schema", () => {
  it("keeps assignedBy as a User reference", () => {
    expect(Task.schema.path("assignedBy").instance).toBe("ObjectId");
    expect(Task.schema.path("assignedBy").options.ref).toBe("User");
  });
});

// BP-463 review. The interval's 365 bound belongs to `normaliseRecurrence`, which every client
// path goes through, and NOT to the schema — because `createNextRecurrence` copies the closed
// task's recurrence verbatim into `Task.create`, which runs full-document validation. Tasks stored
// back when a pasted 400 was accepted end to end still exist; with a schema `max` their first
// close throws into a fire-and-forget `.catch`, so the successor is never minted and the series
// dies with nothing on screen and nothing in the log. That is the failure BP-463 exists to remove.
describe("a recurrence stored before the interval had a bound", () => {
  const legacy = (interval: number) =>
    new Task({
      project: "6a69903ec4c79d7d07a5eda8",
      taskNumber: 1,
      title: "Pay the annual thing",
      createdBy: "69a52cb3399b27d3cbb2c59b",
      recurrence: { frequency: "daily", interval },
    }).validateSync();

  it("still validates, so its series can go on being minted", () => {
    expect(legacy(400)).toBeUndefined();
    expect(legacy(100_000)).toBeUndefined();
  });

  // The control, and the reason the above is about the maximum rather than about validation being
  // switched off: the floor is still the schema's, because nothing legitimate ever wrote a zero.
  it("still refuses an interval below one", () => {
    expect(legacy(0)?.errors["recurrence.interval"]).toBeTruthy();
  });
});

/**
 * BP-381. A task document is spread into a response by a dozen readers — the search, My Tasks, the
 * release and claim routes, and every writer that echoes the task back. The refused change's patch
 * is up to 220 KB, and `patchSha256` and `attempts` are the machine's own bookkeeping. Stripping
 * them reader by reader is a list that goes stale the first time somebody adds a thirteenth, and it
 * had already gone stale twice before this test existed.
 *
 * `select: false` is the same decision made once: a reader that forgets gets nothing.
 */
describe("what a refused change publishes by default", () => {
  const deselected = ["patch", "patchSha256", "attempts", "files"];

  it.each(deselected)("withholds decision.%s unless a reader asks for it", (field) => {
    expect(Task.schema.path(`decision.${field}`).options.select).toBe(false);
  });

  // The control: the fields the panel renders must still travel, or the record is unreadable
  it.each(["gate", "commit", "state", "fileCount", "protectedFiles", "acceptable", "unacceptableReason"])(
    "still carries decision.%s",
    (field) => {
      expect(Task.schema.path(`decision.${field}`).options.select).not.toBe(false);
    }
  );

  /**
   * Nearly every task on the board has never had a change refused, and the board reads a truthy
   * `decision` as "there is something to answer". `execution` above is the cautionary tale: its
   * per-field defaults make it serialise as a truthy object on every task ever written.
   */
  it("is absent, not an empty object, on a task nothing has refused", () => {
    const doc = new Task({
      project: "6a69903ec4c79d7d07a5eda8",
      taskNumber: 1,
      title: "t",
      createdBy: "69a52cb3399b27d3cbb2c59b",
    });

    expect(doc.toObject().decision).toBeNull();
  });

  it("keeps decidedBy a User reference, so a reader can populate it", () => {
    expect(Task.schema.path("decision.decidedBy").instance).toBe("ObjectId");
    expect(Task.schema.path("decision.decidedBy").options.ref).toBe("User");
  });
});
