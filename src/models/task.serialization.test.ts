import { describe, it, expect } from "vitest";
import { Task } from "./task";

describe("Task serialization", () => {
  it("flattens maps, or custom field values never reach the client", () => {
    expect(Task.schema.get("toJSON")).toMatchObject({ flattenMaps: true });
    expect(Task.schema.get("toObject")).toMatchObject({ flattenMaps: true });
  });

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

describe("Task schema", () => {
  it("keeps assignedBy as a User reference", () => {
    expect(Task.schema.path("assignedBy").instance).toBe("ObjectId");
    expect(Task.schema.path("assignedBy").options.ref).toBe("User");
  });
});

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

  it("still refuses an interval below one", () => {
    expect(legacy(0)?.errors["recurrence.interval"]).toBeTruthy();
  });
});
