import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine } from "./sandbox.js";
import { UNCONFINED_ESCAPE_HATCH } from "./env.js";
import { createRunner } from "./exec.js";

/**
 * The profile driven through the real kernel. Every claim in sandbox.ts is about what seatbelt
 * permits, and a test over the profile string can only say the string was composed — which is
 * exactly the shape of assertion that let BP-349 stand open while `~/.claude` was named as
 * sensitive in repos.ts.
 *
 * Skipped off macOS rather than failing: there is no seatbelt to ask, and `confine` already refuses
 * there — a refusal the unit suite pins.
 */
const onMac = process.platform === "darwin";

describe.skipIf(!onMac)("confine against the real sandbox", () => {
  let dir: string;
  let worktree: string;
  let outside: string;

  const runner = createRunner();

  async function confinedSh(script: string) {
    // env: {} so the operator's own risk acceptance cannot switch off the thing under test
    const spawn = confine("/bin/sh", ["-c", script], { writable: [worktree], env: {} });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    return runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp349-"));
    worktree = join(dir, "worktree");
    outside = join(dir, "outside");
    mkdirSync(worktree);
    mkdirSync(outside);
    writeFileSync(join(outside, "settings.json"), "original\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets the agent write inside the worktree it was given", async () => {
    const result = await confinedSh(`echo edited > ${worktree}/file.txt`);

    expect(result.code).toBe(0);
    expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("edited\n");
  });

  // The escape BP-349 is about, with `$HOME/.claude/settings.json` played by a file this test owns:
  // overwriting a file that already exists, outside the one directory the profile allows.
  it("refuses a write to a file outside it, and leaves that file alone", async () => {
    const result = await confinedSh(`echo planted > ${outside}/settings.json`);

    expect(result.code).not.toBe(0);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("original\n");
  });

  it("refuses to create a new file outside it", async () => {
    await confinedSh(`echo planted > ${outside}/hook.sh`);

    expect(existsSync(join(outside, "hook.sh"))).toBe(false);
  });

  it("refuses to delete a file outside it", async () => {
    await confinedSh(`rm -f ${outside}/settings.json`);

    expect(existsSync(join(outside, "settings.json"))).toBe(true);
  });

  // The agent holds Write inside the worktree, so it can put a symlink there and write through it.
  // Seatbelt matching the resolved vnode rather than the path it was handed is the reason this
  // does not reopen the whole thing — asserted rather than assumed, because it is the difference
  // between a confinement and a speed bump (same family as BP-428).
  it("refuses a write through a symlink that leaves the worktree", async () => {
    symlinkSync(outside, join(worktree, "escape"));

    const result = await confinedSh(`echo planted > ${worktree}/escape/settings.json`);

    expect(result.code).not.toBe(0);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("original\n");
  });

  // A child process inherits the sandbox. Without that the confinement would end at the first
  // thing the CLI spawns, which is most of what it does.
  it("holds for a grandchild process, not only the command it wrapped", async () => {
    await confinedSh(`/bin/sh -c "echo planted > ${outside}/grandchild.txt"`);

    expect(existsSync(join(outside, "grandchild.txt"))).toBe(false);
  });

  // `/tmp` is a symlink to `/private/tmp` on macOS, and mkdtemp hands back the `/var/folders/…`
  // form that resolves elsewhere again. A profile built from the unresolved path denies the
  // worktree write — the failure looks like the sandbox working, which is why it is pinned from
  // the permitted side as well as the denied one.
  it("resolves the worktree's parent, so a symlinked temp directory is still writable", async () => {
    const linked = join(dir, "linked");
    symlinkSync(dir, linked);

    const spawn = confine("/bin/sh", ["-c", `echo via-link > ${linked}/worktree/through.txt`], {
      writable: [join(linked, "worktree")],
      env: {},
    });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    const result = await runner.run(spawn.command, spawn.args, { cwd: dir, timeoutMs: 30_000 });

    expect(result.code).toBe(0);
    expect(readFileSync(join(worktree, "through.txt"), "utf8")).toBe("via-link\n");
  });

  // BP-804: never the directory itself, which whatever was allowed it can have replaced
  it("refuses a writable path that is itself a symlink, rather than allowing its target", () => {
    const linked = join(dir, "linked");
    symlinkSync(outside, linked);

    const spawn = confine("/bin/sh", ["-c", "true"], { writable: [linked], env: {} });

    expect("refusal" in spawn && spawn.refusal).toMatch(/is a symlink/);
  });

  /**
   * The write this process never performs: `defaults write` hands the domain to cfprefsd, which
   * runs outside the profile and wrote the plist under `~/Library/Preferences` on its behalf —
   * exit 0, with `file-write*` denied (BP-630).
   *
   * Asserted on the domain rather than on the exit code, and that is not a preference: measured,
   * a `defaults write` of a domain this machine has seen and deleted before exits **0 under the
   * deny while writing nothing at all**. Only asking cfprefsd what it holds tells the two apart,
   * and a test that watched the exit code would have called that pass a failure.
   *
   * The control runs the same command with the operator's escape hatch set, which is what makes
   * this pair capable of failing: without it a `defaults` that could not write for any other
   * reason reads exactly like a confinement that works. Each takes its own domain, because the
   * first one's write is what changes the second one's exit code.
   */
  describe("a write performed by a daemon on the process's behalf", () => {
    const domains: string[] = [];

    // Unique per test: two suites on one machine share ~/Library/Preferences, and a domain left
    // behind by a crashed earlier run must not decide this one.
    function probeDomain(): string {
      const domain = `com.board-planner.worker.sandbox-probe.${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      domains.push(domain);
      return domain;
    }

    const readDomain = (domain: string) =>
      runner.run("/usr/bin/defaults", ["read", domain], { cwd: worktree, timeoutMs: 30_000 });

    // Through a shell that also writes inside the worktree, which is the liveness half: a profile
    // that failed to compile, or a `defaults` that never started, writes no preference either.
    // Measured, that case cannot be told apart by the exit code or by stderr — a `defaults write`
    // of a domain this machine has seen and deleted before exits 0 and says nothing at all, while
    // writing nothing.
    async function writeAs(domain: string, env: NodeJS.ProcessEnv, ran: string) {
      const spawn = confine(
        "/bin/sh",
        ["-c", `/usr/bin/defaults write ${domain} planted yes; echo ran > ${join(worktree, ran)}`],
        { writable: [worktree], env },
      );
      if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
      await runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 });
      return existsSync(join(worktree, ran));
    }

    afterEach(async () => {
      for (const domain of domains.splice(0)) {
        await runner.run("/usr/bin/defaults", ["delete", domain], { cwd: worktree, timeoutMs: 30_000 });
      }
    });

    it("writes the preference when nothing confines it — the control", async () => {
      const domain = probeDomain();

      const ran = await writeAs(domain, { [UNCONFINED_ESCAPE_HATCH]: "1" }, "unconfined.txt");

      expect(ran, "the command never ran, so this proves nothing").toBe(true);
      expect((await readDomain(domain)).stdout).toContain("planted");
    });

    it("leaves no preference behind under the profile", async () => {
      const domain = probeDomain();

      const ran = await writeAs(domain, {}, "confined.txt");

      expect(ran, "the command never ran, so this proves nothing").toBe(true);
      expect((await readDomain(domain)).stdout).not.toContain("planted");
    });
  });

  /**
   * A process this one never spawns (BP-807): LaunchServices starts the bundle itself, so its program
   * runs with ppid 1 and outside the profile. Measured before the deny: `open -g -j` returned 0 and
   * the program wrote where a direct write got EPERM.
   *
   * Each route has a control with the escape hatch set, because an `open` that failed for any
   * other reason would read exactly like the confinement working.
   */
  // A fresh CI runner builds its LaunchServices database on first use, and one `lsregister -dump`
  // took longer there than vitest's 5 s default for a whole test.
  describe("a program launched on the process's behalf", { timeout: 120_000 }, () => {
    const LSREGISTER =
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    let app: string;
    let bundleId: string;
    let launched: string;

    beforeEach(() => {
      bundleId = `com.board-planner.worker.launch-probe.${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      app = join(dir, "Probe.app");
      launched = join(dir, "launched");
      mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
      writeFileSync(
        join(app, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Probe</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`,
      );
      const program = join(app, "Contents", "MacOS", "Probe");
      writeFileSync(program, '#!/bin/sh\necho "ppid=$PPID" > "$(dirname "$0")/../../../launched"\n');
      chmodSync(program, 0o755);
    });

    afterEach(async () => {
      await runner.run(LSREGISTER, ["-u", app], { cwd: dir, timeoutMs: 60_000 });
    }, 90_000);

    async function launchAs(env: NodeJS.ProcessEnv, argv: string[]) {
      const ran = join(worktree, "ran");
      const spawn = confine("/bin/sh", ["-c", `"$@"; echo $? > ${ran}`, "sh", ...argv], {
        writable: [worktree],
        env,
      });
      if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
      await runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 60_000 });
      return existsSync(ran);
    }

    async function launchedWithin(ms: number): Promise<boolean> {
      for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
        if (existsSync(launched)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return existsSync(launched);
    }

    const register = () => runner.run(LSREGISTER, ["-f", app], { cwd: dir, timeoutMs: 60_000 });

    const nsworkspace = [
      "/usr/bin/osascript",
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); function run(argv) { return $.NSWorkspace.sharedWorkspace.launchApplication(argv[0]) }',
    ];

    for (const [route, argv] of [
      ["open", () => ["/usr/bin/open", "-g", "-j", app]],
      ["NSWorkspace", () => [...nsworkspace, app]],
    ] as const) {
      it(`launches the program through ${route} when nothing confines it — the control`, async () => {
        const ran = await launchAs({ [UNCONFINED_ESCAPE_HATCH]: "1" }, argv());

        expect(ran, "the command never ran, so this proves nothing").toBe(true);
        expect(await launchedWithin(10_000)).toBe(true);
        expect(readFileSync(launched, "utf8")).toBe("ppid=1\n");
      });

      // Registered first: for a bundle LaunchServices already knows — one Spotlight indexed, or an
      // earlier run opened — RunningBoard is the path left once CoreServicesUIAgent is denied.
      it(`launches nothing through ${route} under the profile, even for a registered bundle`, async () => {
        await register();

        const ran = await launchAs({}, argv());

        expect(ran, "the command never ran, so this proves nothing").toBe(true);
        expect(await launchedWithin(3_000)).toBe(false);
      });
    }

    // A registration is a launch deferred: a bundle's URL types make it the handler the operator's
    // next click on such a link starts, unconfined.
    // By dump rather than by bundle id: a bundle under a temp directory is registered and still
    // answers nil to NSWorkspace's lookup by identifier, measured.
    const knownToLaunchServices = async () =>
      (
        await runner.run("/bin/sh", ["-c", `${LSREGISTER} -dump | grep -c "^identifier: *${bundleId}$"`], {
          cwd: dir,
          timeoutMs: 60_000,
        })
      ).stdout.trim() !== "0";

    it("registers the bundle when nothing confines it — the control", async () => {
      expect(await launchAs({ [UNCONFINED_ESCAPE_HATCH]: "1" }, [LSREGISTER, "-f", app])).toBe(true);
      expect(await knownToLaunchServices()).toBe(true);
    });

    it("cannot register the bundle under the profile", async () => {
      expect(await launchAs({}, [LSREGISTER, "-f", app])).toBe(true);
      expect(await knownToLaunchServices()).toBe(false);
    });

    // Sending the event itself is not something a test may do: the first one to another app raises
    // a consent prompt on the operator's screen. The port lookup precedes that prompt, and is what
    // the deny refuses — measured, `tell application "Finder" to get count of windows` then fails
    // with -600 and no prompt.
    async function appleEventsReachableAs(env: NodeJS.ProcessEnv) {
      const spawn = confine(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          'function run() { return $.NSMachBootstrapServer.sharedInstance.portForName("com.apple.coreservices.appleevents").isNil() ? "denied" : "reached" }',
        ],
        { writable: [worktree], env },
      );
      if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
      return (await runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 })).stdout.trim();
    }

    it("reaches the AppleEvent daemon when nothing confines it — the control", async () => {
      expect(await appleEventsReachableAs({ [UNCONFINED_ESCAPE_HATCH]: "1" })).toBe("reached");
    });

    it("cannot reach the AppleEvent daemon under the profile", async () => {
      expect(await appleEventsReachableAs({})).toBe("denied");
    });

    // launchd itself refuses to create a job for a sandboxed caller, before and after BP-807. Pinned
    // so that stays a measurement rather than a memory.
    describe("a job submitted to launchd", () => {
      const label = `com.board-planner.worker.launch-probe.${process.pid}`;

      afterEach(async () => {
        await runner.run("/bin/launchctl", ["remove", label], { cwd: dir, timeoutMs: 30_000 });
      }, 60_000);

      const submitAs = (env: NodeJS.ProcessEnv) =>
        launchAs(env, ["/bin/launchctl", "submit", "-l", label, "--", "/bin/sh", "-c", `echo ppid=$PPID > ${launched}`]);

      it("runs when nothing confines it — the control", async () => {
        expect(await submitAs({ [UNCONFINED_ESCAPE_HATCH]: "1" })).toBe(true);
        expect(await launchedWithin(10_000)).toBe(true);
      });

      it("never runs under the profile", async () => {
        expect(await submitAs({})).toBe(true);
        expect(await launchedWithin(3_000)).toBe(false);
      });
    });
  });

  /**
   * BP-720. Reads stay open, so a test the agent wrote can read a credential under HOME; this is
   * what stops the gate that runs it sending one anywhere. 192.0.2.1 is TEST-NET-1, never routed,
   * so the control needs no internet: unconfined it times out or is unreachable, and only the
   * sandbox answers EPERM.
   */
  describe("the network", () => {
    async function confinedNode(script: string, network?: "open" | "loopback") {
      const spawn = confine(process.execPath, ["-e", script], { writable: [worktree], network, env: {} });
      if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
      return runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 });
    }

    const OFF_MACHINE = `
      const net = require("net"), dgram = require("dgram");
      const tcp = new Promise((done) => {
        const socket = net.connect({ host: "192.0.2.1", port: 443, timeout: 2000 });
        socket.on("connect", () => { socket.destroy(); done("connected"); });
        socket.on("timeout", () => { socket.destroy(); done("timeout"); });
        socket.on("error", (error) => done(error.code));
      });
      const udp = new Promise((done) => {
        const socket = dgram.createSocket("udp4");
        socket.send(Buffer.from("x"), 53, "192.0.2.1", (error) => { socket.close(); done(error ? error.code : "sent"); });
      });
      Promise.all([tcp, udp]).then(([t, u]) => console.log(JSON.stringify({ tcp: t, udp: u })));
    `;

    it("refuses a connection off the machine in loopback mode", async () => {
      const result = await confinedNode(OFF_MACHINE, "loopback");

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ tcp: "EPERM", udp: "EPERM" });
    });

    it("leaves the same connection alone in open mode — the control", async () => {
      const result = await confinedNode(OFF_MACHINE);

      expect(result.code, result.stderr).toBe(0);
      const { tcp, udp } = JSON.parse(result.stdout);
      expect(tcp).not.toBe("EPERM");
      expect(udp).toBe("sent");
    });

    it("lets a loopback server answer its own client in loopback mode, on IPv4 and IPv6", async () => {
      const result = await confinedNode(
        `
        const http = require("http");
        const roundTrip = (host) => new Promise((done) => {
          const server = http.createServer((_, res) => res.end("pong")).listen(0, host, async () => {
            const url = "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + server.address().port + "/";
            const body = await (await fetch(url)).text();
            server.close();
            done(body);
          });
        });
        Promise.all([roundTrip("127.0.0.1"), roundTrip("::1")]).then((bodies) => console.log(bodies.join(",")));
        `,
        "loopback"
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("pong,pong");
    });

    // Unix sockets stay open until BP-810 decides otherwise: a suite talking to a local database
    // over one is honest, and a deny on network-outbound alone refuses it
    it("lets a unix-socket server answer its own client in loopback mode", async () => {
      const result = await confinedNode(
        `
        const net = require("net");
        const server = net.createServer((socket) => socket.end("pong")).listen("s.sock", () => {
          let body = "";
          net.connect("s.sock").on("data", (chunk) => (body += chunk)).on("end", () => {
            server.close();
            console.log(body);
          }).on("error", (error) => { console.log(error.code); server.close(); });
        });
        `,
        "loopback"
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("pong");
    });
  });
});
