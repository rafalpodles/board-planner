import { describe, it, expect } from "vitest";
import {
  confine,
  SANDBOX_COMMAND,
  UNCONFINED_ESCAPE_HATCH,
  UNCONFINED_REASON,
} from "./sandbox.js";

const identity = (path: string) => path;

// Empty rather than process.env: an operator who has accepted the risk in their own shell would
// otherwise turn the confinement off inside every test below, and each one would still be green.
function confined(writable: string[], platform: NodeJS.Platform = "darwin") {
  return confine("claude", ["-p", "hello"], { writable, platform, realpath: identity, env: {} });
}

function profileOf(result: ReturnType<typeof confined>): string {
  if (!("command" in result)) throw new Error(`expected a confined spawn, got ${result.refusal}`);
  return result.args[result.args.indexOf("-p") + 1];
}

function paramsOf(result: ReturnType<typeof confined>): Record<string, string> {
  if (!("command" in result)) throw new Error(`expected a confined spawn, got ${result.refusal}`);
  const params: Record<string, string> = {};
  result.args.forEach((arg, index) => {
    if (arg !== "-D") return;
    const assignment = result.args[index + 1];
    const split = assignment.indexOf("=");
    params[assignment.slice(0, split)] = assignment.slice(split + 1);
  });
  return params;
}

describe("confine", () => {
  it("spawns the command through sandbox-exec, with the command itself still last", () => {
    const result = confined(["/work/bp-1"]);
    if (!("command" in result)) throw new Error("expected a confined spawn");

    expect(result.command).toBe(SANDBOX_COMMAND);
    expect(result.args.slice(-3)).toEqual(["claude", "-p", "hello"]);
  });

  // The whole shape of the profile: everything is allowed except writing, and writing is allowed
  // back only under the paths named. A profile that denied nothing would still spawn, still pass
  // every argument test above, and confine nothing at all.
  it("denies every write before allowing any back", () => {
    const profile = profileOf(confined(["/work/bp-1"]));
    const denyAll = profile.indexOf("(deny file-write*)");
    const allowBack = profile.indexOf("(allow file-write*");

    expect(denyAll).toBeGreaterThan(-1);
    expect(allowBack).toBeGreaterThan(denyAll);
  });

  // Seatbelt reads later rules as overriding earlier ones, so an `(allow default)` placed after the
  // deny would silently restore every write. Pinned because the two lines look interchangeable.
  it("puts allow default before the deny, not after it", () => {
    const profile = profileOf(confined(["/work/bp-1"]));

    expect(profile.indexOf("(allow default)")).toBeLessThan(profile.indexOf("(deny file-write*)"));
  });

  // A path travels as a -D parameter rather than as text inside the profile, so a directory name
  // containing a quote or a backslash cannot close the string it sits in and add rules of its own.
  it("passes each writable path as a parameter, never as profile text", () => {
    const evil = '/work/a" (allow file-write* (subpath "/'
    const result = confined([evil, "/work/b"]);

    expect(profileOf(result)).not.toContain(evil);
    expect(Object.values(paramsOf(result))).toContain(evil);
  });

  it("allows writes under every path it was given, and names them all in the profile", () => {
    const result = confined(["/work/bp-1", "/tmp/run-7"]);
    const profile = profileOf(result);
    const params = paramsOf(result);

    expect(Object.values(params)).toEqual(["/work/bp-1", "/tmp/run-7"]);
    for (const name of Object.keys(params)) {
      expect(profile).toContain(`(subpath (param "${name}"))`);
    }
  });

  // Seatbelt matches the resolved path, so /tmp/x and /private/tmp/x are different rules and only
  // one of them is the one the kernel will check. Handing it the unresolved form is a profile that
  // looks right and permits nothing — measured: the worktree write failed, not the escape.
  it("resolves each path before it becomes a rule", () => {
    const result = confine("claude", [], {
      writable: ["/tmp/run-7"],
      platform: "darwin",
      env: {},
      realpath: (path) => (path === "/tmp/run-7" ? "/private/tmp/run-7" : path),
    });

    expect(Object.values(paramsOf(result))).toEqual(["/private/tmp/run-7"]);
  });

  // A path that cannot be resolved is not a path this can confine anything to. Refusing beats
  // falling back to the unresolved string, which would install a rule matching nothing.
  it("refuses when a path cannot be resolved", () => {
    const result = confine("claude", [], {
      writable: ["/gone"],
      platform: "darwin",
      env: {},
      realpath: () => {
        throw new Error("ENOENT");
      },
    });

    expect("refusal" in result && result.refusal).toMatch(/\/gone/);
  });

  // The one thing a confinement must never do quietly.
  it("refuses on a platform it has no sandbox for, rather than spawning unconfined", () => {
    const result = confined(["/work/bp-1"], "linux");

    expect("refusal" in result && result.refusal).toBe(UNCONFINED_REASON);
  });

  it("refuses when it was given nothing to confine to", () => {
    const result = confined([]);

    expect("refusal" in result && result.refusal).toMatch(/no writable/i);
  });

  // stdout is the run's own transport — the CLI writes stream-json to it — and the gates write
  // nothing to /dev but a discard. Named literals rather than a subpath, so the allowance cannot
  // grow into the rest of /dev with it.
  it("allows the null device, and only by name", () => {
    const profile = profileOf(confined(["/work/bp-1"]));

    expect(profile).toContain('(allow file-write-data (literal "/dev/null"))');
    expect(profile).not.toContain('(subpath "/dev")');
  });
});

describe("the operator's escape hatch", () => {
  const withHatch = (value: string, platform: NodeJS.Platform = "linux") =>
    confine("claude", ["-p", "hello"], {
      writable: ["/work/bp-1"],
      platform,
      realpath: identity,
      env: { [UNCONFINED_ESCAPE_HATCH]: value },
    });

  it("runs the command bare where the risk has been accepted", () => {
    const result = withHatch("1");
    if (!("command" in result)) throw new Error(`expected a spawn, got ${result.refusal}`);

    expect(result.command).toBe("claude");
    expect(result.args).toEqual(["-p", "hello"]);
  });

  // The one field that tells a caller which of the two it got. Without it an unconfined spawn is
  // indistinguishable from a confined one at every call site, which is how a risk acceptance stops
  // being visible in the log that follows it.
  it("says that what it returned is not confined", () => {
    const result = withHatch("1");

    expect("confined" in result && result.confined).toBe(false);
  });

  it("means the same thing on the platform that does have a sandbox", () => {
    const result = withHatch("true", "darwin");

    expect("confined" in result && result.confined).toBe(false);
  });

  // Anything else is not an acceptance. "0" and "false" read as switching it off to anyone who has
  // met an environment variable before, and the empty string is what an unset variable looks like
  // once a shell has exported it.
  it.each(["0", "false", "no", "", "  "])("does not read %o as an acceptance", (value) => {
    const result = withHatch(value);

    expect("refusal" in result && result.refusal).toBe(UNCONFINED_REASON);
  });

  it("is off when the variable is absent, so nothing turns the sandbox off by accident", () => {
    const result = confine("claude", [], {
      writable: ["/work/bp-1"],
      platform: "linux",
      realpath: identity,
      env: {},
    });

    expect("refusal" in result).toBe(true);
  });
});
