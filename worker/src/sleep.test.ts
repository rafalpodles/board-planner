import { describe, it, expect, vi, afterEach } from "vitest";
import { abortableSleep } from "./sleep.js";

describe("abortableSleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits the whole interval when nothing aborts it", async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const waiting = abortableSleep(30_000).then(settled);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await waiting;

    expect(settled).toHaveBeenCalled();
  });

  // The point of the whole change: resolving early is not enough, because a pending setTimeout is a
  // referenced handle and the process will not exit while one is outstanding
  it("clears the timer on abort rather than leaving a handle the event loop still waits on", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const waiting = abortableSleep(30_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    await waiting;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns without arming a timer when the signal is already aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await abortableSleep(30_000, controller.signal);

    expect(vi.getTimerCount()).toBe(0);
  });
});
