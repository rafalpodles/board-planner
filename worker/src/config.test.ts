import { describe, it, expect, vi } from "vitest";
import { homedir } from "os";
import { join } from "path";
import {
  DEFAULT_POLICY,
  applyPolicy,
  loadBootstrap,
  localSocketPath,
  modelOr,
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
    expect(() => loadBootstrap(base)).not.toThrow();
  });

  it("boots with no CP_API_TOKEN at all", () => {
    expect(() => loadBootstrap({ ...base, CP_API_TOKEN: undefined })).not.toThrow();
  });

  it("throws when the worker name is missing", () => {
    expect(() => loadBootstrap({ ...base, CP_WORKER_NAME: undefined })).toThrow(/CP_WORKER_NAME/);
  });
});

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

  it("does not stop the boot over a badly-permissioned leftover file", () => {
    const read = vi.fn(() => {
      throw new Error("/secrets/token is readable by group or others (mode 644)");
    });

    expect(() => loadBootstrap({ ...base, CP_API_TOKEN_FILE: "/secrets/token" }, read)).not.toThrow();
  });
});

describe("applyPolicy", () => {
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

  it.each([
    "--output=/tmp/pwned",
    "-o/tmp/pwned",
    ".hidden",
    "main..evil",
    "main//evil",
    "release/",
    "wip.lock",
    "main; touch /tmp/pwned",
    "main branch",
  ])("ignores a baseBranch git would not read as a ref: %j", (baseBranch) => {
    expect(applyPolicy(DEFAULT_POLICY, { baseBranch }).baseBranch).toBe(DEFAULT_POLICY.baseBranch);
  });

  it.each(["main", "develop", "release/1.2", "v1.0", "feature/BP-327_fix"])(
    "keeps a baseBranch that is a ref name: %j",
    (baseBranch) => {
      expect(applyPolicy(DEFAULT_POLICY, { baseBranch }).baseBranch).toBe(baseBranch);
    }
  );

  it.each(["--dangerously-skip-permissions", "-p", "opus; touch /tmp/pwned"])(
    "ignores a model name that is option-shaped or not a name: %j",
    (model) => {
      const next = applyPolicy(DEFAULT_POLICY, {
        model,
        fallbackModel: model,
        reviewModel: model,
      });
      expect(next.model).toBe(DEFAULT_POLICY.model);
      expect(next.fallbackModel).toBe(DEFAULT_POLICY.fallbackModel);
      expect(next.reviewModel).toBe(DEFAULT_POLICY.reviewModel);
    }
  );

  it.each(["opus", "sonnet", "claude-opus-5", "moonshotai/kimi-k2.6", "us.anthropic.claude-v2:1"])(
    "keeps a model name the CLI would accept: %j",
    (model) => {
      expect(applyPolicy(DEFAULT_POLICY, { model }).model).toBe(model);
    }
  );
});

describe("modelOr", () => {
  it("falls back for a blank value, as it always has", () => {
    expect(modelOr("", "opus")).toBe("opus");
    expect(modelOr("   ", "opus")).toBe("opus");
    expect(modelOr(undefined, "opus")).toBe("opus");
  });

  it.each(["--dangerously-skip-permissions", "-p", "opus sonnet", "opus; touch /tmp/pwned"])(
    "falls back rather than passing %j to the CLI",
    (value) => {
      expect(modelOr(value, "opus")).toBe("opus");
    }
  );

  it("keeps a model name, trimmed", () => {
    expect(modelOr("  claude-opus-5  ", "opus")).toBe("claude-opus-5");
  });
});

describe("parseAssignments", () => {
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
