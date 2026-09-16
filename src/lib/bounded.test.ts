import { describe, it, expect } from "vitest";
import { runBounded } from "./bounded";

describe("runBounded", () => {
  it("never has more than the limit running, and runs every item", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];

    await runBounded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      done.push(n);
    });

    expect(peak).toBe(3);
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("starts the first batch before it returns, so fire-and-forget callers still send at once", () => {
    const started: number[] = [];
    void runBounded([1, 2, 3], 2, (n) => {
      started.push(n);
      return new Promise(() => {});
    });

    expect(started).toEqual([1, 2]);
  });

  it("keeps going past a task that fails", async () => {
    const done: number[] = [];

    await runBounded([1, 2, 3], 1, async (n) => {
      if (n === 1) throw new Error("boom");
      done.push(n);
    });

    expect(done).toEqual([2, 3]);
  });
});
