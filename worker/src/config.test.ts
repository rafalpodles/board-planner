import { describe, it, expect, vi } from "vitest";
import { homedir } from "os";
import { join } from "path";
import {
  DEFAULT_POLICY,
  applyPolicy,
  loadBootstrap,
  localSocketPath,
  parseAssignments,
  stateDirFrom,
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
    expect(loadBootstrap(base).stateDir).toBe(join(homedir(), ".boardplanner"));
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
      join(homedir(), ".boardplanner", "worker.sock")
    );
  });

  it("does not require a project or a repository path", () => {
    // CP_PROJECT_ID and CP_REPO_PATH are gone: assignments and their proposed paths come from
    // the server now, not from the environment
    expect(() => loadBootstrap(base)).not.toThrow();
  });

  // CP-237 removed the second credential, so this is no longer a boot requirement. The worker's
  // own credential is minted by registration and its scope follows its assignments.
  it("boots with no CP_API_TOKEN at all", () => {
    expect(() => loadBootstrap({ ...base, CP_API_TOKEN: undefined })).not.toThrow();
  });

  it("throws when the worker name is missing", () => {
    expect(() => loadBootstrap({ ...base, CP_WORKER_NAME: undefined })).toThrow(/CP_WORKER_NAME/);
  });
});

// Nothing reads this any more; it is still parsed so an existing plist keeps booting unchanged.
describe("the legacy api token", () => {
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

  it("is simply empty when neither way is set, rather than refusing to boot", () => {
    expect(loadBootstrap(base, vi.fn()).apiToken).toBe("");
  });

  it("is empty rather than fatal when the file is empty", () => {
    expect(
      loadBootstrap({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, () => "  \n").apiToken
    ).toBe("");
  });

  // It used to stop the boot, which was right while the token was load-bearing. Now that nothing
  // reads it, a badly-permissioned leftover file must not keep a working worker from starting.
  it("does not stop the boot over a badly-permissioned leftover file", () => {
    const read = vi.fn(() => {
      throw new Error("/secrets/token is readable by group or others (mode 644)");
    });

    expect(() => loadBootstrap({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, read)).not.toThrow();
  });
});

describe("applyPolicy", () => {
  // The one field the worker recomputes rather than adopts: a ceiling past the server's own lease
  // gets the task reclaimed under a running worker
  it("clamps a run ceiling that would outlive the server's lease", () => {
    expect(applyPolicy(DEFAULT_POLICY, { runCeilingMs: 8 * 60 * 60_000 }).runCeilingMs).toBeLessThan(
      2 * 60 * 60_000
    );
  });

  it("keeps the run ceiling it already had when a patch does not mention one", () => {
    const first = applyPolicy(DEFAULT_POLICY, { runCeilingMs: 3_600_000 });
    expect(applyPolicy(first, { baseBranch: "develop" }).runCeilingMs).toBe(3_600_000);
  });

  it("adopts every known field from a well-formed patch", () => {
    const next = applyPolicy(DEFAULT_POLICY, {
      baseBranch: "develop",
      pollIntervalMs: 5_000,
      taskTimeoutMs: 60_000,
      runCeilingMs: 3_600_000,
      maxDiffLines: 100,
      maxDiffFiles: 3,
      model: "sonnet",
      fallbackModel: "haiku",
      reviewModel: "opus-4",
    });

    expect(next).toEqual({
      baseBranch: "develop",
      pollIntervalMs: 5_000,
      taskTimeoutMs: 60_000,
      runCeilingMs: 3_600_000,
      maxDiffLines: 100,
      maxDiffFiles: 3,
      model: "sonnet",
      fallbackModel: "haiku",
      reviewModel: "opus-4",
    });
  });

  // The reviewer is the last gate before a merge, so it does not move when the implementer does
  it("leaves the review model alone when only the implementer's model changes", () => {
    const next = applyPolicy(DEFAULT_POLICY, { model: "haiku" });

    expect(next.model).toBe("haiku");
    expect(next.reviewModel).toBe(DEFAULT_POLICY.reviewModel);
    expect(next.fallbackModel).toBe(DEFAULT_POLICY.fallbackModel);
  });

  it("ignores a blank model rather than adopting an empty flag value", () => {
    const next = applyPolicy(DEFAULT_POLICY, { model: "   ", fallbackModel: "", reviewModel: "  " });

    expect(next.model).toBe(DEFAULT_POLICY.model);
    expect(next.fallbackModel).toBe(DEFAULT_POLICY.fallbackModel);
    expect(next.reviewModel).toBe(DEFAULT_POLICY.reviewModel);
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
  // An assignment names a remote, never a path: the worker resolves its own checkout from it, so
  // the server has no way to point this machine at a directory.
  it("keeps a well-formed assignment", () => {
    const assignments = parseAssignments([{ project: "p1", remote: "git@github.com:o/r.git" }]);
    expect(assignments).toEqual([{ project: "p1", remote: "git@github.com:o/r.git" }]);
  });

  it("carries the project's own policy alongside it", () => {
    const assignments = parseAssignments([
      { project: "p1", remote: "git@github.com:o/r.git", policy: { autoMerge: true } },
    ]);
    expect(assignments[0].policy).toEqual({ autoMerge: true });
  });

  it("drops an entry missing a remote, keeping the rest", () => {
    const assignments = parseAssignments([
      { project: "p1" },
      { project: "p2", remote: "git@github.com:o/r2.git" },
    ]);
    expect(assignments).toEqual([{ project: "p2", remote: "git@github.com:o/r2.git" }]);
  });

  it("returns an empty list for anything that is not an array", () => {
    expect(parseAssignments(undefined)).toEqual([]);
    expect(parseAssignments(null)).toEqual([]);
    expect(parseAssignments("nope")).toEqual([]);
  });
});

// The autoMerge and reviewGate describes stood here. Both flags are retired: an agent merges
// because its sequence carries a Merge step, and is reviewed because a Reviewed gate stands after
// the last step that writes. agent-rules.test.ts is where those two rules are asserted now.

// `node dist/main.js --preflight` is what the app runs before a machine has enrolled: no CP_API_URL,
// no CP_WORKER_NAME, nothing loadBootstrap would accept. It still has to find the state directory,
// because the pinned GitHub account lives there and the check answers for that identity.
describe("stateDirFrom", () => {
  it("resolves without any of the variables a bootstrap needs", () => {
    expect(stateDirFrom({ CP_STATE_DIR: "/Users/rpo/rig/state" })).toBe("/Users/rpo/rig/state");
    expect(stateDirFrom({})).toMatch(/\.boardplanner$/);
  });

  it("agrees with the bootstrap the running worker loads", () => {
    const env = {
      CP_API_URL: "https://board.example.com",
      CP_WORKER_NAME: "machine",
      CP_STATE_DIR: "/state",
    };

    expect(stateDirFrom(env)).toBe(loadBootstrap(env).stateDir);
  });
});
