import { describe, it, expect, vi } from "vitest";
import { hostname } from "os";
import { join } from "path";
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
    expect(cfg.worktreeRoot).toBe(join(base.CP_REPO_PATH, "..", "cp-worktrees"));
  });

  it("passes required string fields through unchanged", () => {
    const cfg = loadConfig(base);
    expect(cfg.apiBaseUrl).toBe("https://app.example.com");
    expect(cfg.apiToken).toBe("cp_token");
    expect(cfg.projectId).toBe("CP");
    expect(cfg.repoPath).toBe("/repo");
  });

  it("strips a trailing slash from the API base URL", () => {
    const cfg = loadConfig({ ...base, CP_API_URL: "https://app.example.com/" });
    expect(cfg.apiBaseUrl).toBe("https://app.example.com");
  });

  it("honours an explicit base branch", () => {
    expect(loadConfig({ ...base, CP_BASE_BRANCH: "develop" }).baseBranch).toBe("develop");
  });

  it("honours an explicit worktree root", () => {
    const cfg = loadConfig({ ...base, CP_WORKTREE_ROOT: "/custom/worktrees" });
    expect(cfg.worktreeRoot).toBe("/custom/worktrees");
  });

  it("throws naming the missing variable", () => {
    expect(() => loadConfig({ ...base, CP_API_TOKEN: undefined })).toThrow(/CP_API_TOKEN/);
  });

  it("rejects a zero value, naming the variable", () => {
    expect(() => loadConfig({ ...base, CP_CONCURRENCY: "0" })).toThrow(/CP_CONCURRENCY/);
  });

  it("rejects a negative value, naming the variable", () => {
    expect(() => loadConfig({ ...base, CP_MAX_DIFF_LINES: "-1" })).toThrow(/CP_MAX_DIFF_LINES/);
  });

  it("rejects a non-finite value, naming the variable", () => {
    expect(() => loadConfig({ ...base, CP_MAX_DIFF_FILES: "not-a-number" })).toThrow(
      /CP_MAX_DIFF_FILES/,
    );
  });

  it("derives a stable worker id from the hostname when unset", () => {
    expect(loadConfig(base).workerId).toBe(`worker-${hostname()}`);
  });

  it("honours an explicit worker id override", () => {
    expect(loadConfig({ ...base, CP_WORKER_ID: "custom-worker" }).workerId).toBe("custom-worker");
  });
});

describe("the api token", () => {
  const base = {
    CP_API_URL: "https://app.example.com",
    CP_PROJECT_ID: "CP",
    CP_REPO_PATH: "/repo",
  };

  it("reads it from a file when the environment does not carry it", () => {
    const read = vi.fn().mockReturnValue("cp_from_file\n");

    const config = loadConfig({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, read);

    expect(config.apiToken).toBe("cp_from_file");
    expect(read).toHaveBeenCalledWith("/secrets/token");
  });

  it("prefers an inline token, so a container needs no file", () => {
    const read = vi.fn();

    expect(loadConfig({ ...base, CP_API_TOKEN: "cp_inline" }, read).apiToken).toBe("cp_inline");
    expect(read).not.toHaveBeenCalled();
  });

  it("names both ways when neither is set", () => {
    expect(() => loadConfig(base, vi.fn())).toThrow(/CP_API_TOKEN or CP_API_TOKEN_FILE/);
  });

  it("refuses an empty secret file rather than authenticating as nobody", () => {
    expect(() =>
      loadConfig({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, () => "  \n")
    ).toThrow(/empty file/);
  });

  it("lets the reader's own refusal through, so loose file permissions stop the boot", () => {
    const read = vi.fn(() => {
      throw new Error("/secrets/token is readable by group or others (mode 644)");
    });

    expect(() => loadConfig({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, read)).toThrow(
      /readable by group or others/
    );
  });
});
