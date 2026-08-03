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
