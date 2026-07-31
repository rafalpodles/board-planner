import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  CP_API_URL: "https://app.example.com",
  CP_API_TOKEN: "cp_token",
  CP_PROJECT_ID: "CP",
  CP_REPO_PATH: "/repo",
};

describe("loadConfig", () => {
  it("applies defaults for optional settings", () => {
    const cfg = loadConfig(base);
    expect(cfg.pollIntervalMs).toBe(30_000);
    expect(cfg.taskTimeoutMs).toBe(1_800_000);
    expect(cfg.concurrency).toBe(1);
    expect(cfg.maxDiffLines).toBe(400);
    expect(cfg.maxDiffFiles).toBe(10);
    expect(cfg.baseBranch).toBe("main");
  });

  it("honours an explicit base branch", () => {
    expect(loadConfig({ ...base, CP_BASE_BRANCH: "develop" }).baseBranch).toBe("develop");
  });

  it("throws naming the missing variable", () => {
    expect(() => loadConfig({ ...base, CP_API_TOKEN: undefined })).toThrow(/CP_API_TOKEN/);
  });

  it("derives a stable worker id from the hostname when unset", () => {
    expect(loadConfig(base).workerId).toMatch(/.+/);
  });
});
