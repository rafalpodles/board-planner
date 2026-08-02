import { describe, it, expect } from "vitest";
import {
  isPmRunnable,
  isPmLockedByInstance,
  pmDisabledReason,
  PM_RUNNABLE_QUERY,
} from "./gate";

describe("isPmRunnable", () => {
  it("runs only when enabled", () => {
    expect(isPmRunnable({ enabled: true })).toBe(true);
    expect(isPmRunnable({ enabled: false })).toBe(false);
  });

  // CP-166: an instance lock the project side cannot clear must beat pm.enabled
  it("refuses an instance-locked project even when enabled", () => {
    expect(isPmRunnable({ enabled: true, lockedByInstance: true })).toBe(false);
  });

  it("treats a missing config as not runnable", () => {
    expect(isPmRunnable(undefined)).toBe(false);
    expect(isPmRunnable(null)).toBe(false);
    expect(isPmRunnable({})).toBe(false);
  });
});

describe("isPmLockedByInstance", () => {
  it("is true only for an explicit lock", () => {
    expect(isPmLockedByInstance({ enabled: true, lockedByInstance: true })).toBe(true);
    expect(isPmLockedByInstance({ enabled: true })).toBe(false);
    expect(isPmLockedByInstance(undefined)).toBe(false);
  });

  // A locked project must not be sent to project settings, which cannot clear the lock
  it("distinguishes a lock from a plain disable", () => {
    expect(isPmLockedByInstance({ enabled: false })).toBe(false);
  });
});

describe("pmDisabledReason", () => {
  it("names the instance admin when locked", () => {
    expect(pmDisabledReason({ enabled: true, lockedByInstance: true })).toMatch(
      /instance admin/i
    );
  });

  it("falls back to the project-level reason", () => {
    expect(pmDisabledReason({ enabled: false })).toMatch(/not enabled for this project/i);
    expect(pmDisabledReason(undefined)).toMatch(/not enabled for this project/i);
  });
});

describe("PM_RUNNABLE_QUERY", () => {
  // The Mongo form and the in-process guard must agree, or bulk selection and per-request
  // checks disagree about which agents may run
  it("mirrors isPmRunnable", () => {
    expect(PM_RUNNABLE_QUERY).toEqual({
      "pm.enabled": true,
      "pm.lockedByInstance": { $ne: true },
    });
  });

  it("matches exactly the configs isPmRunnable accepts", () => {
    const matches = (pm: { enabled?: boolean; lockedByInstance?: boolean }) =>
      pm.enabled === true && pm.lockedByInstance !== true;

    const cases = [
      { enabled: true },
      { enabled: true, lockedByInstance: false },
      { enabled: true, lockedByInstance: true },
      { enabled: false },
      {},
    ];
    for (const pm of cases) {
      expect(matches(pm)).toBe(isPmRunnable(pm));
    }
  });
});
