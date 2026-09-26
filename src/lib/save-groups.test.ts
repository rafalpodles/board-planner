import { describe, it, expect } from "vitest";
import { saveAllGroups } from "./save-groups";

function group(label: string, behaviour: "ok" | "throw", log: string[]) {
  return {
    label,
    save: async () => {
      log.push(label);
      if (behaviour === "throw") throw new Error(`${label} failed`);
    },
  };
}

describe("saveAllGroups", () => {
  it("reports nothing failed when every group saves", async () => {
    const log: string[] = [];
    const failed = await saveAllGroups([group("A", "ok", log), group("B", "ok", log)]);

    expect(failed).toEqual([]);
    expect(log).toEqual(["A", "B"]);
  });

  // The bar used to await each group in turn with no catch, so one rejection abandoned
  // every group behind it — and each section swallows its own errors, so it looked saved
  it("saves the groups behind a failing one", async () => {
    const log: string[] = [];
    const failed = await saveAllGroups([
      group("A", "ok", log),
      group("B", "throw", log),
      group("C", "ok", log),
    ]);

    expect(log).toEqual(["A", "B", "C"]);
    expect(failed).toEqual(["B"]);
  });

  // Board access can take the reader's own ownership away, and everything saved after it would be
  // refused — so it goes last, whatever order the groups were changed in
  it("saves a group marked to go last after all the others", async () => {
    const log: string[] = [];
    await saveAllGroups([
      { ...group("Access", "ok", log), saveLast: true },
      group("Identity", "ok", log),
      group("Board", "ok", log),
    ]);

    expect(log).toEqual(["Identity", "Board", "Access"]);
  });

  it("names every group that failed", async () => {
    const log: string[] = [];
    const failed = await saveAllGroups([
      group("A", "throw", log),
      group("B", "ok", log),
      group("C", "throw", log),
    ]);

    expect(failed).toEqual(["A", "C"]);
  });

  it("saves one at a time rather than racing them", async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number) => ({
      label,
      save: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push(label);
            resolve();
          }, ms)
        ),
    });

    await saveAllGroups([slow("slow", 20), slow("fast", 1)]);

    expect(order).toEqual(["slow", "fast"]);
  });
});
