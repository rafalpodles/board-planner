import { describe, it, expect } from "vitest";
import pkg from "../../package.json";
import { getBuildInfo, resolveSha } from "./build-info";

const FULL = "951c99b6a1d2e3f40718293a4b5c6d7e8f901234";

describe("resolveSha", () => {
  it("reads the Docker build's GIT_SHA first, then Railway's, then SOURCE_VERSION", () => {
    expect(resolveSha({ GIT_SHA: FULL, RAILWAY_GIT_COMMIT_SHA: "b".repeat(40), SOURCE_VERSION: "c".repeat(40) })).toBe(FULL);
    expect(resolveSha({ RAILWAY_GIT_COMMIT_SHA: "b".repeat(40), SOURCE_VERSION: "c".repeat(40) })).toBe("b".repeat(40));
    expect(resolveSha({ SOURCE_VERSION: "c".repeat(40) })).toBe("c".repeat(40));
  });

  it("says unknown when nothing names a commit, and for an image built by hand with an empty argument", () => {
    expect(resolveSha({})).toBe("unknown");
    expect(resolveSha({ GIT_SHA: "" })).toBe("unknown");
    expect(resolveSha({ GIT_SHA: "   " })).toBe("unknown");
  });

  // The value is served to every signed-in caller, so a variable holding anything but a hex digest
  // must not be echoed back
  it("refuses a value that is not a commit digest, and falls through to the next variable", () => {
    expect(resolveSha({ GIT_SHA: "main" })).toBe("unknown");
    expect(resolveSha({ GIT_SHA: "$(whoami)" })).toBe("unknown");
    expect(resolveSha({ GIT_SHA: "g".repeat(40) })).toBe("unknown");
    expect(resolveSha({ GIT_SHA: "abc12", RAILWAY_GIT_COMMIT_SHA: FULL })).toBe(FULL);
  });

  it("trims and lower-cases", () => {
    expect(resolveSha({ GIT_SHA: `  ${FULL.toUpperCase()}\n` })).toBe(FULL);
  });
});

describe("getBuildInfo", () => {
  it("carries package.json's version and a seven-character short SHA", () => {
    const info = getBuildInfo({ GIT_SHA: FULL });

    expect(info.version).toBe(pkg.version);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.sha).toBe(FULL);
    expect(info.shortSha).toBe("951c99b");
  });

  it("keeps unknown as unknown rather than cutting it to seven characters", () => {
    expect(getBuildInfo({})).toMatchObject({ sha: "unknown", shortSha: "unknown" });
  });

  it("reports the process start, the same value on every call", () => {
    const first = getBuildInfo({});
    const second = getBuildInfo({});

    expect(Number.isNaN(Date.parse(first.startedAt))).toBe(false);
    expect(first.startedAt).toBe(second.startedAt);
    expect(Date.parse(first.startedAt)).toBeLessThanOrEqual(Date.now());
  });
});
