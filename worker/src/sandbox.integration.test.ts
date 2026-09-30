import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { confine } from "./sandbox.js";
import { childEnv, UNCONFINED_ESCAPE_HATCH } from "./env.js";
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
    }, 30_000);

    it("leaves the same connection alone in open mode — the control", async () => {
      const result = await confinedNode(OFF_MACHINE);

      expect(result.code, result.stderr).toBe(0);
      const { tcp, udp } = JSON.parse(result.stdout);
      expect(tcp).not.toBe("EPERM");
      expect(udp).toBe("sent");
    }, 30_000);

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
    }, 30_000);

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
    }, 30_000);
  });

  /**
   * BP-720. A daemon fetches outside the profile, so `network-outbound` never sees it: each of these
   * reached a listener from a process with no network at all. The listener is on 127.0.0.1, which
   * loopback mode allows the process itself, so a request arriving there in loopback mode can only
   * have come from a daemon the deny did not stop. Open mode is the control.
   */
  describe("a fetch a daemon performs on the process's behalf", () => {
    let seen: string[] = [];
    let server: Server;
    let base = "";
    let pki = "";

    beforeAll(async () => {
      server = createServer((req, res) => {
        seen.push(req.url ?? "");
        res.end("x");
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      pki = mkdtempSync(join(tmpdir(), "bp720-pki-"));
      const openssl = (...args: string[]) => execFileSync("/usr/bin/openssl", args, { cwd: pki, stdio: "ignore" });
      openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=BP720 probe CA");
      openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=probe.bp720.test");
      writeFileSync(
        join(pki, "leaf.ext"),
        `extendedKeyUsage=serverAuth\nsubjectAltName=DNS:probe.bp720.test\nauthorityInfoAccess=caIssuers;URI:${base}/aia-DUMMY,OCSP;URI:${base}/ocsp-DUMMY\n`
      );
      openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.ext");
    });

    afterAll(() => {
      server.close();
      rmSync(pki, { recursive: true, force: true });
    });

    beforeEach(() => {
      seen = [];
    });

    async function confinedRun(command: string, args: string[], network?: "open" | "loopback") {
      const spawn = confine(command, args, { writable: [worktree], network, env: {} });
      if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
      await runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 });
      await new Promise((done) => setTimeout(done, 1500));
      return seen.join(" ");
    }

    const jxa = (body: string) => ["-l", "JavaScript", "-e", `ObjC.import("Cocoa"); ObjC.import("WebKit"); ${body}`];
    const backgroundSession = () =>
      jxa(`
        var config = $.NSClassFromString("NSURLSessionConfiguration").backgroundSessionConfigurationWithIdentifier("bp720.probe." + Math.random());
        var task = $.NSClassFromString("NSURLSession").sessionWithConfiguration(config).downloadTaskWithURL($.NSURL.URLWithString("${base}/nsurl-DUMMY"));
        task.resume;
        delay(3);
      `);
    const webView = () =>
      jxa(`
        var view = $.NSClassFromString("WKWebView").alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, 10, 10), $.NSClassFromString("WKWebViewConfiguration").alloc.init);
        view.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString("${base}/webkit-DUMMY")));
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(4));
      `);
    const verifyCert = () => ["verify-cert", "-c", join(pki, "leaf.pem"), "-r", join(pki, "ca.pem"), "-p", "ssl", "-R", "ocsp", "-R", "require"];

    it.each([
      ["nsurlsessiond", "/usr/bin/osascript", backgroundSession, "/nsurl-DUMMY"],
      ["trustd", "/usr/bin/security", verifyCert, "/ocsp-DUMMY"],
      ["WebKit's networking process", "/usr/bin/osascript", webView, "/webkit-DUMMY"],
    ])("%s fetches in open mode — the control — and not in loopback mode", async (_, command, args, path) => {
      expect(await confinedRun(command, args())).toContain(path);
      seen = [];
      expect(await confinedRun(command, args(), "loopback")).not.toContain("DUMMY");
    }, 60_000);
  });

  // Daemons that run a command or a container for whoever connects to their socket (BP-810).
  // Played by sockets this test owns at the paths the real ones use, since no CI runner has Docker,
  // colima, OrbStack, podman or watchman running; tmux and screen are also driven for real below.
  // Paths are relative to `dir` because a socket path is capped at 104 bytes.
  describe("a local daemon reached over a unix socket", { timeout: 60_000 }, () => {
    const uid = process.getuid!();
    const user = userInfo().username;
    const SERVE =
      'const { mkdirSync } = require("fs"), { dirname } = require("path"), net = require("net");' +
      "const paths = process.argv.slice(1); let listening = 0;" +
      "for (const p of paths) { mkdirSync(dirname(p), { recursive: true });" +
      'net.createServer((c) => c.end()).listen(p, () => { if (++listening === paths.length) console.log("ready") }) }';
    const CONNECT =
      'require("net").connect(process.argv[1])' +
      '.on("connect", function () { console.log("connected"); this.destroy() })' +
      '.on("error", (e) => console.log(e.code))';

    // Two daemons put their socket at a fixed system path rather than in a home, so their fixtures
    // are there too, named for this process and removed afterwards.
    const userTemp = onMac ? realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim()) : "";
    const podmanApi = join(userTemp, "podman", `bp810-probe-${process.pid}.sock`);
    const tmuxDefault = `/private/tmp/tmux-${uid}/bp810-probe-${process.pid}`;

    const named = [
      ["a docker.sock anywhere", "var/run/docker.sock"],
      ["another socket of Docker's in ~/.docker", ".docker/sandboxes/sandboxd.sock"],
      ["Docker Desktop's own sockets", "Library/Containers/com.docker.docker/Data/docker-cli.sock"],
      ["colima", ".colima/default/containerd.sock"],
      ["colima under ~/.config", ".config/colima/default/containerd.sock"],
      ["OrbStack", ".orbstack/vmcontrol.sock"],
      ["podman's machine API in the user's temp directory", podmanApi],
      ["podman's older machine socket", ".local/share/containers/podman/machine/qemu/podman.sock"],
      ["a tmux server in tmux's default directory", tmuxDefault],
      ["a tmux server under a $TMUX_TMPDIR the worker's environment does not name", `tmux-home/tmux-${uid}/default`],
      ["a screen that listens on a socket", ".screen/4242.ttys001.host"],
      ["a screen in the system socket directory", `screens/S-${user}/4242.ttys001.host`],
      ["watchman", `watchman/${user}-state/sock`],
    ] as const;
    // The last two are directories named like a daemon's in a place no daemon uses: an honest
    // project's own sockets, which the patterns must not reach.
    const ordinary = [
      "app.sock",
      "worktree/test-server.sock",
      "dockerish.sock",
      "worktree/podman/x.sock",
      "worktree/colima/t.sock",
    ];

    let server: ChildProcess | undefined;
    const createdDirs: string[] = [];

    beforeEach(async () => {
      for (const system of [dirname(podmanApi), dirname(tmuxDefault)]) {
        if (existsSync(system)) continue;
        mkdirSync(system, { mode: 0o700 });
        createdDirs.push(system);
      }
      const child = spawn(process.execPath, ["-e", SERVE, ...named.map(([, path]) => path), ...ordinary], {
        cwd: dir,
        stdio: ["ignore", "pipe", "inherit"],
      });
      server = child;
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (chunk) => String(chunk).includes("ready") && resolve());
        child.on("exit", (code) => reject(new Error(`the socket server exited with ${code}`)));
      });
    });

    afterEach(() => {
      server?.kill();
      server = undefined;
      rmSync(podmanApi, { force: true });
      rmSync(tmuxDefault, { force: true });
      for (const created of createdDirs.splice(0)) {
        try {
          rmdirSync(created);
        } catch {
          // something of the operator's now lives there
        }
      }
    });

    async function connectAs(env: NodeJS.ProcessEnv, path: string) {
      const spawned = confine(process.execPath, ["-e", CONNECT, path], { writable: [worktree], env });
      if (!("command" in spawned)) throw new Error(`refused: ${spawned.refusal}`);
      return (await runner.run(spawned.command, spawned.args, { cwd: dir, timeoutMs: 30_000 })).stdout.trim();
    }

    for (const [daemon, path] of named) {
      it(`connects to ${daemon} when nothing confines it — the control`, async () => {
        expect(await connectAs({ [UNCONFINED_ESCAPE_HATCH]: "1" }, path)).toBe("connected");
      });

      it(`cannot connect to ${daemon} under the profile`, async () => {
        expect(await connectAs({}, path)).toBe("EPERM");
      });
    }

    it("still connects to an ordinary socket under the profile, the worktree's own included", async () => {
      for (const path of ordinary) expect(await connectAs({}, path), path).toBe("connected");
    });

    // The build and test gates' mode (BP-720) allows every unix socket back; the named denies come
    // after it, so they still hold there.
    it("still refuses every named socket in the gates' loopback-only mode", async () => {
      const connectInLoopback = async (path: string) => {
        const spawned = confine(process.execPath, ["-e", CONNECT, path], {
          writable: [worktree],
          network: "loopback",
          env: {},
        });
        if (!("command" in spawned)) throw new Error(`refused: ${spawned.refusal}`);
        return (await runner.run(spawned.command, spawned.args, { cwd: dir, timeoutMs: 30_000 })).stdout.trim();
      };

      for (const [, path] of named) expect(await connectInLoopback(path), path).toBe("EPERM");
      for (const path of ordinary) expect(await connectInLoopback(path), path).toBe("connected");
    });

    it("refuses a named socket reached through a symlink the agent put in its worktree", async () => {
      symlinkSync(join(dir, "var/run/docker.sock"), join(worktree, "innocent"));

      expect(await connectAs({ [UNCONFINED_ESCAPE_HATCH]: "1" }, "worktree/innocent")).toBe("connected");
      expect(await connectAs({}, "worktree/innocent")).toBe("EPERM");
    });

    // Measured before the deny: `run-shell` from inside the profile ran with the server as its
    // parent, outside the sandbox, and wrote where a direct write could not.
    const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((path) => existsSync(path));

    // Under a `$TMUX_TMPDIR` the confined process is not told about, as a LaunchAgent is not.
    describe.skipIf(!TMUX)("a tmux server started outside the sandbox", () => {
      let tmuxTmpdir: string;
      let socket: string;

      beforeEach(async () => {
        tmuxTmpdir = join(dir, "tmux-home");
        socket = join(tmuxTmpdir, `tmux-${uid}`, "probe");
        mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
        const started = await runner.run(TMUX!, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "sleep 600"], {
          cwd: dir,
          timeoutMs: 30_000,
        });
        expect(started.code, started.stderr).toBe(0);
      });

      afterEach(async () => {
        await runner.run(TMUX!, ["-S", socket, "kill-server"], { cwd: dir, timeoutMs: 30_000 });
      });

      async function runShellAs(env: NodeJS.ProcessEnv, marker: string) {
        const spawned = confine(TMUX!, ["-S", socket, "run-shell", `echo ran > ${join(outside, marker)}`], {
          writable: [worktree],
          env,
        });
        if (!("command" in spawned)) throw new Error(`refused: ${spawned.refusal}`);
        await runner.run(spawned.command, spawned.args, { cwd: dir, timeoutMs: 30_000 });
        return existsSync(join(outside, marker));
      }

      it("runs a command for the caller when nothing confines it — the control", async () => {
        expect(await runShellAs({ [UNCONFINED_ESCAPE_HATCH]: "1" }, "tmux-unconfined")).toBe(true);
      });

      it("runs nothing for a caller under the profile", async () => {
        expect(await runShellAs({}, "tmux-confined")).toBe(false);
      });
    });

    // macOS's own screen listens on a FIFO rather than a socket, and opening it for writing is a
    // write outside the worktree, so the write deny refuses it without a rule of its own.
    const SCREEN = "/usr/bin/screen";

    describe.skipIf(!existsSync(SCREEN))("macOS's screen, started outside the sandbox", () => {
      const session = `bp810-${process.pid}`;
      let env: NodeJS.ProcessEnv;
      let windowPid: string;

      beforeEach(async () => {
        windowPid = join(dir, "screen-window.pid");
        const screendir = join(dir, ".screen-fifo");
        mkdirSync(screendir, { mode: 0o700 });
        env = { ...childEnv(), SCREENDIR: screendir };
        await runner.run(SCREEN, ["-dmS", session, "/bin/sh", "-c", `echo $$ > ${windowPid}; exec /bin/sleep 600`], {
          cwd: dir,
          timeoutMs: 30_000,
          env,
        });
        for (const deadline = Date.now() + 10_000; readdirSync(screendir).length === 0 && Date.now() < deadline; ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });

      // `quit` leaves the window running under screen's `login` wrapper, reparented to launchd
      afterEach(async () => {
        await runner.run(SCREEN, ["-S", session, "-X", "quit"], { cwd: dir, timeoutMs: 30_000, env });
        try {
          process.kill(Number(readFileSync(windowPid, "utf8")), "SIGKILL");
        } catch {
          // already gone, or never started
        }
      });

      async function openWindowAs(hatch: NodeJS.ProcessEnv, marker: string) {
        const spawned = confine(SCREEN, ["-S", session, "-X", "screen", "/bin/sh", "-c", `echo ran > ${join(outside, marker)}`], {
          writable: [worktree],
          env: hatch,
        });
        if (!("command" in spawned)) throw new Error(`refused: ${spawned.refusal}`);
        await runner.run(spawned.command, spawned.args, { cwd: dir, timeoutMs: 30_000, env });
        for (const deadline = Date.now() + 3_000; !existsSync(join(outside, marker)) && Date.now() < deadline; ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return existsSync(join(outside, marker));
      }

      it("runs a command for the caller when nothing confines it — the control", async () => {
        expect(await openWindowAs({ [UNCONFINED_ESCAPE_HATCH]: "1" }, "screen-unconfined")).toBe(true);
      });

      it("runs nothing for a caller under the profile", async () => {
        expect(await openWindowAs({}, "screen-confined")).toBe(false);
      });
    });
  });

  // `launchctl disable gui/<uid>/<label>` worked from inside the profile and persists across
  // reboots; `bootout` stopped a job. Probed only with subcommands that change nothing even if a
  // regression let them through, so no failure can write to launchd's database.
  describe("launchctl", () => {
    const LAUNCHCTL = "/bin/launchctl";
    const domain = `gui/${process.getuid!()}`;
    const label = "com.board-planner.worker.sandbox-probe.absent";

    async function launchctlAs(env: NodeJS.ProcessEnv, args: string[]) {
      const spawned = confine(LAUNCHCTL, args, { writable: [worktree], env });
      if (!("command" in spawned)) throw new Error(`refused: ${spawned.refusal}`);
      return runner.run(spawned.command, spawned.args, { cwd: dir, timeoutMs: 30_000 });
    }

    it("runs when nothing confines it — the control", async () => {
      const result = await launchctlAs({ [UNCONFINED_ESCAPE_HATCH]: "1" }, ["version"]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Bootstrapper");
    });

    // Known gap: the deny names the binary, not launchd. A plain copy is killed by AMFI for its
    // entitlements; one re-signed ad hoc is not, and runs. If this starts failing, macOS has closed
    // the gap and the README's "still open" can say so. Skipped where a re-signed copy does not run
    // even unconfined — an ad hoc signature on the arm64e slice is not accepted everywhere.
    it("KNOWN GAP: a copy re-signed ad hoc in the worktree still runs under the profile", async (ctx) => {
      const probe = join(dir, "launchctl-probe");
      const signed = await runner.run(
        "/bin/sh",
        ["-c", `cp ${LAUNCHCTL} ${probe} && /usr/bin/codesign -f -s - ${probe} && ${probe} version`],
        { cwd: dir, timeoutMs: 30_000 },
      );
      if (signed.code !== 0 || !signed.stdout.includes("Bootstrapper")) {
        ctx.skip(`a re-signed launchctl does not run here even unconfined (exit ${signed.code}): nothing to measure`);
      }

      const copy = join(worktree, "launchctl");
      const spawned = confine(
        "/bin/sh",
        ["-c", `cp ${LAUNCHCTL} ${copy} && /usr/bin/codesign -f -s - ${copy} && ${copy} version`],
        { writable: [worktree], env: {} },
      );
      if (!("command" in spawned)) throw new Error(`refused: ${spawned.refusal}`);

      const result = await runner.run(spawned.command, spawned.args, { cwd: dir, timeoutMs: 30_000 });

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Bootstrapper");
    });

    it("cannot run under the profile, not even to read", async () => {
      for (const args of [["version"], ["print-disabled", domain], ["kickstart", `${domain}/${label}`]]) {
        const result = await launchctlAs({}, args);

        expect(result.code, args.join(" ")).not.toBe(0);
        expect(result.stderr, args.join(" ")).toContain("Operation not permitted");
        expect(result.stdout, args.join(" ")).toBe("");
      }
    });
  });
});
