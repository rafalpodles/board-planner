import { describe, it, expect } from "vitest";
import { estimateOf, sumEstimates } from "./estimates";
import { ApiTask } from "@/types";

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
