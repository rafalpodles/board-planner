import { describe, it, expect } from "vitest";
import { estimateFieldName, estimateOf, roundForDisplay, sumEstimates } from "./estimates";
import { ApiCustomField, ApiTask } from "@/types";

function task(customFieldValues: Record<string, unknown>): ApiTask {
  return { customFieldValues } as ApiTask;
}

describe("estimateOf", () => {
  it("reads the designated field", () => {
    expect(estimateOf(task({ f1: 3 }), "f1")).toBe(3);
  });

  it("treats an absent value as zero", () => {
    expect(estimateOf(task({}), "f1")).toBe(0);
  });

  it("treats a value that is not a number as zero", () => {
    expect(estimateOf(task({ f1: "three" }), "f1")).toBe(0);
  });

  it("treats a numeric string as its number, as the writers store it", () => {
    expect(estimateOf(task({ f1: "3" }), "f1")).toBe(3);
  });

  it("reads the value under the given field id, not any other field on the task", () => {
    expect(estimateOf(task({ f1: 3, f2: 99 }), "f2")).toBe(99);
    expect(estimateOf(task({ f1: 3, f2: 99 }), "f1")).toBe(3);
  });

  it("treats a task with no customFieldValues at all as zero, not a crash", () => {
    expect(estimateOf({} as ApiTask, "f1")).toBe(0);
  });

  it("treats a stored boolean as zero, not a number", () => {
    expect(estimateOf(task({ f1: true }), "f1")).toBe(0);
    expect(estimateOf(task({ f1: false }), "f1")).toBe(0);
  });

  it("treats a stored array or object as zero, not whatever Number() coerces it to", () => {
    expect(estimateOf(task({ f1: [5] }), "f1")).toBe(0);
    expect(estimateOf(task({ f1: {} }), "f1")).toBe(0);
  });
});

describe("sumEstimates", () => {
  it("sums nothing to zero", () => {
    expect(sumEstimates([], "f1")).toBe(0);
  });

  it("sums across every task, mixing numbers, numeric strings, and absent values", () => {
    const tasks = [task({ f1: 2 }), task({ f1: "5" }), task({}), task({ f1: "not a number" })];
    expect(sumEstimates(tasks, "f1")).toBe(7);
  });
});

function field(over: Partial<ApiCustomField> & { _id: string; name: string }): ApiCustomField {
  return {
    fieldType: "number",
    options: [],
    required: false,
    order: 0,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
    ...over,
  } as ApiCustomField;
}

describe("roundForDisplay", () => {
  it("rounds a binary floating-point addition artifact to a clean value", () => {
    expect(1.1 + 2.2).not.toBe(3.3);
    expect(roundForDisplay(1.1 + 2.2)).toBe(3.3);
  });

  it("reconciles the server's compensated sum with the client's plain reduce", () => {
    expect(roundForDisplay(0.6000000000000001)).toBe(roundForDisplay(0.6));
  });

  it("leaves a whole number as itself, not a decimal", () => {
    expect(roundForDisplay(5)).toBe(5);
  });

  it("keeps precision up to two decimal places", () => {
    expect(roundForDisplay(3.14159)).toBe(3.14);
  });

  it("leaves zero and negative values alone", () => {
    expect(roundForDisplay(0)).toBe(0);
    expect(roundForDisplay(-5)).toBe(-5);
  });

  it("passes through non-finite input rather than producing NaN silently", () => {
    expect(roundForDisplay(NaN)).toBeNaN();
    expect(roundForDisplay(Infinity)).toBe(Infinity);
  });
});

describe("estimateFieldName", () => {
  it("names the designated field", () => {
    const fields = [field({ _id: "f1", name: "Story points" }), field({ _id: "f2", name: "Hours" })];
    expect(estimateFieldName({ customFields: fields }, "f2")).toBe("Hours");
  });

  it("is empty when no field on the project matches the id", () => {
    const fields = [field({ _id: "f1", name: "Story points" })];
    expect(estimateFieldName({ customFields: fields }, "f9")).toBe("");
  });

  it("is empty when the project itself is not given", () => {
    expect(estimateFieldName(null, "f1")).toBe("");
    expect(estimateFieldName(undefined, "f1")).toBe("");
  });
});
