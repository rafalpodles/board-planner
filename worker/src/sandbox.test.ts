import { describe, it, expect } from "vitest";
import { confine, confineTool, DirStat, SANDBOX_COMMAND, UNCONFINED_REASON } from "./sandbox.js";
import { UNCONFINED_ESCAPE_HATCH } from "./env.js";
import { CLAUDE_PATH } from "./__fixtures__/tool-paths.js";

const identity = (path: string) => path;
const stat = (kind: "directory" | "symlink" | "file", ino = 7): DirStat => ({
  dev: 1,
  ino,
  isDirectory: () => kind === "directory",
  isSymbolicLink: () => kind === "symlink",
});
const aDirectory = () => stat("directory");

// Empty rather than process.env: an operator who has accepted the risk in their own shell would
// otherwise turn the confinement off inside every test below, and each one would still be green.
function confined(writable: string[], platform: NodeJS.Platform = "darwin") {
  return confine(CLAUDE_PATH, ["-p", "hello"], { writable, platform, realpath: identity, lstat: aDirectory, env: {} });
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
  // A wrapper whose job is to constrain a hostile process must not be findable at a name: the
  // worker extends its own PATH with directories preflight resolved, and anything earlier on that
  // PATH would otherwise become the sandbox.
  it("names the sandbox by absolute path, never by a name the PATH resolves", () => {
    expect(SANDBOX_COMMAND.startsWith("/")).toBe(true);
  });

  it("spawns the command through sandbox-exec, with the command itself still last", () => {
    const result = confined(["/work/bp-1"]);
    if (!("command" in result)) throw new Error("expected a confined spawn");

    expect(result.command).toBe(SANDBOX_COMMAND);
    expect(result.args.slice(-3)).toEqual([CLAUDE_PATH, "-p", "hello"]);
  });

  // The whole shape of the profile: everything is allowed except writing, and writing is allowed
  // back only under the paths named. A profile that denied nothing would still spawn and still pass
  // every argument test above — measured, and it lets the outside write through.
  //
  // Their ORDER is deliberately not asserted. It reads as though it must matter, and it does not:
  // measured on macOS 26.6.2, the outside write is denied with `(allow default)` moved last and
  // with the deny placed after the allow-back. A test pinning the order would look like a safety
  // net over a property this system does not have. The order that ships is justified in sandbox.ts.
  it("denies every write, and allows back only the paths it was given", () => {
    const profile = profileOf(confined(["/work/bp-1"]));

    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(allow file-write* (subpath (param \"W0\")))");
  });

  // A path travels as a -D parameter rather than as text inside the profile, so a directory name
  // containing a quote or a backslash cannot close the string it sits in and add rules of its own.
  it("passes each writable path as a parameter, never as profile text", () => {
    const evil = '/work/a" (allow file-write* (subpath "/x'
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
    const result = confine(CLAUDE_PATH, [], {
      writable: ["/tmp/run-7"],
      platform: "darwin",
      env: {},
      realpath: (path) => (path === "/tmp" ? "/private/tmp" : path),
      lstat: aDirectory,
    });

    expect(Object.values(paramsOf(result))).toEqual(["/private/tmp/run-7"]);
  });

  // BP-804. Any process that was allowed a directory can replace it with a symlink, and resolving it
  // would hand the next confinement wherever that points — `$HOME`, measured.
  it("resolves only the parent, and refuses a path that is itself a symlink", () => {
    const resolved: string[] = [];
    const result = confine(CLAUDE_PATH, [], {
      writable: ["/work/bp-1"],
      platform: "darwin",
      env: {},
      realpath: (path) => {
        resolved.push(path);
        return path === "/work/bp-1" ? "/Users/operator" : path;
      },
      lstat: () => stat("symlink"),
    });

    expect(resolved).toEqual(["/work"]);
    expect("refusal" in result && result.refusal).toMatch(/\/work\/bp-1 is a symlink/);
  });

  it("refuses a path that is not a directory", () => {
    const result = confine(CLAUDE_PATH, [], {
      writable: ["/work/bp-1"],
      platform: "darwin",
      env: {},
      realpath: identity,
      lstat: () => stat("file"),
    });

    expect("refusal" in result && result.refusal).toMatch(/not a directory/);
  });
});

describe("a directory recorded at creation (BP-804)", () => {
  const recorded = { path: "/private/work/bp-1", dev: 1, ino: 7 };
  const confinedTo = (lstat: (path: string) => DirStat) =>
    confine(CLAUDE_PATH, [], {
      writable: [recorded],
      platform: "darwin",
      env: {},
      realpath: () => {
        throw new Error("a recorded directory is never resolved again");
      },
      lstat,
    });

  it("is the rule as it was recorded, never resolved again", () => {
    expect(Object.values(paramsOf(confinedTo(aDirectory)))).toEqual(["/private/work/bp-1"]);
  });

  it.each([
    ["a symlink", () => stat("symlink"), /replaced by a symlink/],
    ["another directory at the same path", () => stat("directory", 8), /replaced by another directory/],
    ["something that is not a directory", () => stat("file"), /not a directory/],
    [
      "nothing",
      () => {
        throw new Error("ENOENT");
      },
      /removed/,
    ],
  ] as const)("is refused once it is %s", (_, lstat, reason) => {
    const result = confinedTo(lstat);

    expect("refusal" in result && result.refusal).toMatch(reason);
    expect("refusal" in result && result.refusal).toContain("/private/work/bp-1");
  });

  // A path that cannot be resolved is not a path this can confine anything to. Refusing beats
  // falling back to the unresolved string, which would install a rule matching nothing.
  it("refuses when a path cannot be resolved", () => {
    const result = confine(CLAUDE_PATH, [], {
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

  // The write `file-write*` cannot see, because this process never performs it: `defaults write`
  // asks cfprefsd, which runs outside the profile. Both service names — the per-user agent answers
  // where the daemon does not. sandbox.integration.test.ts is what proves the kernel honours it;
  // this is what a Linux runner, which skips that suite, still gets to assert (BP-630).
  it("denies the preference daemon, so a write it would perform is not available either", () => {
    const profile = profileOf(confined(["/work/bp-1"]));

    expect(profile).toContain(
      '(deny mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))'
    );
  });

  // BP-807. All four in one rule: denying either launch path alone leaves the other one launching.
  it("denies the services that launch an app or carry an AppleEvent on the process's behalf", () => {
    const profile = profileOf(confined(["/work/bp-1"]));

    expect(profile).toContain(
      '(deny mach-lookup (global-name "com.apple.coreservices.quarantine-resolver") (global-name "com.apple.runningboard") ' +
        '(global-name "com.apple.lsd.modifydb") (global-name "com.apple.coreservices.appleevents"))'
    );
  });
});

// BP-733. sandbox-exec looks the program it wraps up by name on the PATH this process assembled, so
// the program is held to the rule SANDBOX_COMMAND already is — and the unconfined spawn runs it
// directly, where the same lookup applies.
describe("the network (BP-720)", () => {
  const withNetwork = (network?: "open" | "loopback") =>
    profileOf(confine(CLAUDE_PATH, ["-p"], { writable: ["/work/bp-1"], network, realpath: identity, lstat: aDirectory, platform: "darwin", env: {} }));

  it("leaves the network alone unless asked, so the agent's own spawns still reach the API", () => {
    expect(withNetwork()).not.toContain("network");
    expect(withNetwork("open")).toBe(withNetwork());
  });

  it("denies every outbound connection in loopback mode, and allows back only localhost and unix sockets", () => {
    const profile = withNetwork("loopback");

    expect(profile).toContain("(deny network-outbound)");
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*") (remote unix-socket))');
    expect(profile.startsWith(withNetwork())).toBe(true);
  });

  it("denies the daemons that fetch on a process's behalf in loopback mode, and only there", () => {
    const deny =
      '(deny mach-lookup (global-name "com.apple.nsurlsessiond") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (xpc-service-name "com.apple.WebKit.Networking"))';

    expect(withNetwork("loopback")).toContain(deny);
    expect(withNetwork()).not.toContain("nsurlsessiond");
  });
});

describe("the program inside the wrapper", () => {
  it("is refused by name, confined or not", () => {
    const options = { writable: ["/work/bp-1"], platform: "darwin" as const, realpath: identity, lstat: aDirectory, env: {} };

    expect(confine("claude", ["-p"], options)).toEqual({
      refusal: 'refusing to run "claude" by name on PATH: confine needs its absolute path',
    });
    expect(
      confine("claude", ["-p"], { ...options, env: { [UNCONFINED_ESCAPE_HATCH]: "1" } }),
    ).toHaveProperty("refusal");
  });

  it("is refused by the tool's own name when preflight resolved no path for it", () => {
    const result = confineTool("npm", "", ["test"], {
      writable: ["/work/bp-1"],
      platform: "darwin",
      realpath: identity, lstat: aDirectory,
      env: {},
    });

    expect(result).toEqual({ refusal: "no absolute npm path was resolved — refusing to run npm by name on PATH" });
  });

  it("wraps the resolved path when there is one", () => {
    const result = confineTool("npm", "/opt/homebrew/bin/npm", ["test"], {
      writable: ["/work/bp-1"],
      platform: "darwin",
      realpath: identity, lstat: aDirectory,
      env: {},
    });
    if (!("command" in result)) throw new Error(`expected a confined spawn, got ${result.refusal}`);

    expect(result.command).toBe(SANDBOX_COMMAND);
    expect(result.args.slice(-2)).toEqual(["/opt/homebrew/bin/npm", "test"]);
  });
});

describe("the operator's escape hatch", () => {
  const withHatch = (value: string, platform: NodeJS.Platform = "linux") =>
    confine(CLAUDE_PATH, ["-p", "hello"], {
      writable: ["/work/bp-1"],
      platform,
      realpath: identity, lstat: aDirectory,
      env: { [UNCONFINED_ESCAPE_HATCH]: value },
    });

  it("runs the command bare where the risk has been accepted", () => {
    const result = withHatch("1");
    if (!("command" in result)) throw new Error(`expected a spawn, got ${result.refusal}`);

    expect(result.command).toBe(CLAUDE_PATH);
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
    const result = confine(CLAUDE_PATH, [], {
      writable: ["/work/bp-1"],
      platform: "linux",
      realpath: identity, lstat: aDirectory,
      env: {},
    });

    expect("refusal" in result).toBe(true);
  });
});
