import { describe, it, expect } from "vitest";
import { Task } from "./task";
import {
  toApiDecision,
  DECISION_FIELDS_A_READER_NEEDS,
  DECISION_FIELDS_FOR_THE_POLL,
} from "@/lib/task-decisions";

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
  const deselected = ["patch", "patchSha256", "attempts", "files", "protectedFiles"];

  it.each(deselected)("withholds decision.%s unless a reader asks for it", (field) => {
    expect(Task.schema.path(`decision.${field}`).options.select).toBe(false);
  });

  // The control: the fields the panel renders must still travel, or the record is unreadable
  it.each(["gate", "commit", "state", "fileCount", "protectedFileCount", "acceptable", "unacceptableReason"])(
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

/**
 * The other half of `select: false`: the readers that DO need a withheld field have to name it,
 * and `+decision.patch` compiles to an EXCLUSION projection, so a field given `select: false`
 * joins that exclusion silently. That is how the panel's "What tripped the gate" left the product
 * for seven review rounds — the schema changed, the two readers did not, every suite stayed green.
 *
 * Neither side of this is a hand-written list. What the serialiser needs is OBSERVED, by handing
 * it a proxy and recording the reads; what the schema withholds is read off the schema. Add a
 * sixth deselected field that `toApiDecision` renders and this goes red on its own; add one it
 * does not read and it correctly stays quiet.
 *
 * What it cannot see, and what the e2e is for: whether mongoose honours the string. A parent
 * inclusion (`.select("decision")`) names nothing and defeats every `select: false` under it, and
 * this test would call that fine.
 */
describe("what a reader has to ask for", () => {
  function fieldsRead(decision: Record<string, unknown>): string[] {
    const read = new Set<string>();
    const probe = new Proxy(decision, {
      get(target, key) {
        read.add(String(key));
        return target[String(key)];
      },
    });
    toApiDecision(probe as never, null, true);
    return [...read];
  }

  it("names every withheld field the serialiser reads", () => {
    // Twice, and unioned. A read inside a `||` or a `?.` is taken only when the value before it
    // falls the right way, so one probe reports what its VALUES provoked rather than what the
    // function can touch. Fully populated and near-empty between them take both sides.
    const populated = {
      gate: "protected-paths",
      fileCount: 3,
      protectedFiles: ["package.json"],
      protectedFileCount: 1,
      patch: "diff --git a/a b/a",
      patchTruncated: false,
      commit: "a".repeat(40),
      workerId: "6a7c686f70ed274cf658b1b3",
      taskKey: "BP-1",
      title: "t",
      acceptable: true,
      unacceptableReason: "",
      state: "pending",
      decidedBy: null,
      decidedAt: new Date(),
      prUrl: "",
      error: "",
      createdAt: new Date(),
    };
    const read = new Set([
      ...fieldsRead(populated),
      ...fieldsRead({ gate: "protected-paths" }),
    ]);

    const withheld = [...read].filter(
      (field) => Task.schema.path(`decision.${field}`)?.options.select === false
    );
    // Or the loop below is vacuous and this file would pass with the constant emptied
    expect(withheld.sort()).toEqual(["patch", "protectedFiles"]);

    const named = DECISION_FIELDS_A_READER_NEEDS.split(/\s+/).filter(Boolean);
    for (const field of withheld) {
      expect(named).toContain(`+decision.${field}`);
    }

    // The poll is the third reader and the only one whose projection is written out in full, so
    // without this line a sixth deselected field would redden the loop above and leave the route
    // that must carry it green — the original bug, in the one place the constant does not reach.
    // Its omission of the patch is deliberate and is the single exception.
    const poll = DECISION_FIELDS_FOR_THE_POLL.split(/\s+/).filter(Boolean);
    for (const field of withheld.filter((name) => name !== "patch")) {
      expect(poll).toContain(`decision.${field}`);
    }
    expect(poll).not.toContain("decision.patch");
  });
});
