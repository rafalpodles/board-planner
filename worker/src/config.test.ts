import { describe, it, expect, vi } from "vitest";
import { homedir } from "os";
import { join } from "path";
import {
  applyPolicy,
  DEFAULT_POLICY,
  loadBootstrap,
  localSocketPath,
  parseAssignments,
} from "./config.js";

const base = {
  CP_API_URL: "https://app.example.com",
  CP_API_TOKEN: "cp_token",
  CP_WORKER_NAME: "worker-1",
};

describe("loadBootstrap", () => {
  it("passes required string fields through unchanged", () => {
    const bootstrap = loadBootstrap(base);
    expect(bootstrap.apiBaseUrl).toBe("https://app.example.com");
    expect(bootstrap.apiToken).toBe("cp_token");
    expect(bootstrap.workerName).toBe("worker-1");
  });

  it("strips a trailing slash from the API base URL", () => {
    const bootstrap = loadBootstrap({ ...base, CP_API_URL: "https://app.example.com/" });
    expect(bootstrap.apiBaseUrl).toBe("https://app.example.com");
  });

  it("defaults the state dir under the home directory", () => {
    expect(loadBootstrap(base).stateDir).toBe(join(homedir(), ".claudeplanner"));
  });

  it("honours an explicit state dir", () => {
    const bootstrap = loadBootstrap({ ...base, CP_STATE_DIR: "/custom/state" });
    expect(bootstrap.stateDir).toBe("/custom/state");
  });

  // The menubar app has to find the socket without asking the worker where it put it, so its
  // location is derived from the one directory both sides already agree on
  it("puts the local control socket in the state dir the operator chose", () => {
    const bootstrap = loadBootstrap({ ...base, CP_STATE_DIR: "/custom/state" });
    expect(localSocketPath(bootstrap.stateDir)).toBe("/custom/state/worker.sock");
  });

  it("puts the local control socket under the home directory by default", () => {
    expect(localSocketPath(loadBootstrap(base).stateDir)).toBe(
      join(homedir(), ".claudeplanner", "worker.sock")
    );
  });

  it("does not require a project or a repository path", () => {
    // CP_PROJECT_ID and CP_REPO_PATH are gone: assignments and their proposed paths come from
    // the server now, not from the environment
    expect(() => loadBootstrap(base)).not.toThrow();
  });

  it("throws naming the missing variable", () => {
    expect(() => loadBootstrap({ ...base, CP_API_TOKEN: undefined })).toThrow(/CP_API_TOKEN/);
  });

  it("throws when the worker name is missing", () => {
    expect(() => loadBootstrap({ ...base, CP_WORKER_NAME: undefined })).toThrow(/CP_WORKER_NAME/);
  });
});

describe("the api token", () => {
  const base = { CP_API_URL: "https://app.example.com", CP_WORKER_NAME: "worker-1" };

  it("reads it from a file when the environment does not carry it", () => {
    const read = vi.fn().mockReturnValue("cp_from_file\n");

    const bootstrap = loadBootstrap({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, read);

    expect(bootstrap.apiToken).toBe("cp_from_file");
    expect(read).toHaveBeenCalledWith("/secrets/token");
  });

  it("prefers an inline token, so a container needs no file", () => {
    const read = vi.fn();

    expect(loadBootstrap({ ...base, CP_API_TOKEN: "cp_inline" }, read).apiToken).toBe("cp_inline");
    expect(read).not.toHaveBeenCalled();
  });

  it("names both ways when neither is set", () => {
    expect(() => loadBootstrap(base, vi.fn())).toThrow(/CP_API_TOKEN or CP_API_TOKEN_FILE/);
  });

  it("refuses an empty secret file rather than authenticating as nobody", () => {
    expect(() =>
      loadBootstrap({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, () => "  \n")
    ).toThrow(/empty file/);
  });

  it("lets the reader's own refusal through, so loose file permissions stop the boot", () => {
    const read = vi.fn(() => {
      throw new Error("/secrets/token is readable by group or others (mode 644)");
    });

    expect(() => loadBootstrap({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, read)).toThrow(
      /readable by group or others/
    );
  });
});

describe("applyPolicy", () => {
  it("adopts every known field from a well-formed patch", () => {
    const next = applyPolicy(DEFAULT_POLICY, {
      baseBranch: "develop",
      pollIntervalMs: 5_000,
      taskTimeoutMs: 60_000,
      maxDiffLines: 100,
      maxDiffFiles: 3,
      model: "sonnet",
    });

    expect(next).toEqual({
      baseBranch: "develop",
      pollIntervalMs: 5_000,
      taskTimeoutMs: 60_000,
      maxDiffLines: 100,
      maxDiffFiles: 3,
      model: "sonnet",
    });
  });

  it("ignores a field the server did not send, keeping the current value", () => {
    const next = applyPolicy(DEFAULT_POLICY, { baseBranch: "develop" });
    expect(next.pollIntervalMs).toBe(DEFAULT_POLICY.pollIntervalMs);
  });

  // A patch may carry fields this version of the worker has never heard of — dropped, not adopted
  it("ignores a field the worker does not recognise", () => {
    const next = applyPolicy(DEFAULT_POLICY, { baseBranch: "develop", futureField: "x" });
    expect(next).not.toHaveProperty("futureField");
    expect(next.baseBranch).toBe("develop");
  });

  it("ignores a known field carrying the wrong type instead of adopting it", () => {
    const next = applyPolicy(DEFAULT_POLICY, { pollIntervalMs: "soon", maxDiffLines: -1 });
    expect(next.pollIntervalMs).toBe(DEFAULT_POLICY.pollIntervalMs);
    expect(next.maxDiffLines).toBe(DEFAULT_POLICY.maxDiffLines);
  });

  it("ignores a non-object patch instead of throwing", () => {
    expect(applyPolicy(DEFAULT_POLICY, null)).toEqual(DEFAULT_POLICY);
    expect(applyPolicy(DEFAULT_POLICY, undefined)).toEqual(DEFAULT_POLICY);
    expect(applyPolicy(DEFAULT_POLICY, "develop")).toEqual(DEFAULT_POLICY);
  });

  it("replaces a later patch without needing the caller to restart anything", () => {
    const first = applyPolicy(DEFAULT_POLICY, { pollIntervalMs: 5_000 });
    const second = applyPolicy(first, { pollIntervalMs: 10_000 });
    expect(second.pollIntervalMs).toBe(10_000);
  });
});

describe("parseAssignments", () => {
  it("keeps a well-formed assignment", () => {
    const assignments = parseAssignments([{ project: "p1", proposedPath: "/repo" }]);
    expect(assignments).toEqual([{ project: "p1", proposedPath: "/repo" }]);
  });

  it("drops an entry missing proposedPath, keeping the rest", () => {
    const assignments = parseAssignments([
      { project: "p1" },
      { project: "p2", proposedPath: "/repo2" },
    ]);
    expect(assignments).toEqual([{ project: "p2", proposedPath: "/repo2" }]);
  });

  it("returns an empty list for anything that is not an array", () => {
    expect(parseAssignments(undefined)).toEqual([]);
    expect(parseAssignments(null)).toEqual([]);
    expect(parseAssignments("nope")).toEqual([]);
  });
});
