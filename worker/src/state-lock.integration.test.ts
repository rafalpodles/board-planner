import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { localSocketPath, socketMovedOutOfStateDir } from "./config.js";
import { confine } from "./sandbox.js";
import { STATE_LOCK_NAME, STATE_PID_NAME } from "./state-lock.js";

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_MS = 20_000;

let scratch = "";
let entry = "";
const started: ChildProcess[] = [];
const stateDirs: string[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "cp-state-lock-"));
  const build = join(scratch, "build");
  mkdirSync(build);
  writeFileSync(join(build, "package.json"), JSON.stringify({ type: "module", version: "0.0.0-test" }));
  execFileSync(join(WORKER_ROOT, "node_modules", ".bin", "tsc"), ["-p", WORKER_ROOT, "--outDir", join(build, "dist")], {
    stdio: "pipe",
  });
  entry = join(build, "dist", "main.js");
}, 120_000);

afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of stateDirs.splice(0)) {
    const socket = localSocketPath(dir);
    if (socketMovedOutOfStateDir(dir, socket)) rmSync(dirname(socket), { recursive: true, force: true });
  }
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function newStateDir(): string {
  const dir = mkdtempSync(join(scratch, "state-"));
  stateDirs.push(dir);
  return dir;
}

interface Worker {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<number | null>;
}

function startWorker(stateDir: string): Worker {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CP_API_URL: "http://127.0.0.1:9",
      CP_WORKER_NAME: "state-lock-test",
      CP_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  started.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, stderr: () => stderr, exited };
}

function status(stateDir: string): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ socketPath: localSocketPath(stateDir), path: "/status", agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

async function answering(stateDir: string, worker: Worker): Promise<void> {
  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    if (worker.child.exitCode !== null) throw new Error(`worker exited: ${worker.stderr()}`);
    if ((await status(stateDir)) === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`worker never answered on its socket: ${worker.stderr()}`);
}

function exitWithin(worker: Worker, ms: number): Promise<number | null | "running"> {
  return Promise.race([worker.exited, new Promise<"running">((resolve) => setTimeout(() => resolve("running"), ms))]);
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

describe("one worker per state directory", () => {
  it("refuses a second worker, naming the first, and leaves the first running", async () => {
    const stateDir = newStateDir();
    const first = startWorker(stateDir);
    await answering(stateDir, first);

    const second = startWorker(stateDir);
    expect(await exitWithin(second, STARTUP_MS)).toBe(1);
    expect(second.stderr()).toContain(`(pid ${first.child.pid})`);
    expect(second.stderr()).toContain(stateDir);

    expect(alive(first.child)).toBe(true);
    expect(await status(stateDir)).toBe(200);
  }, 60_000);

  it("starts after the previous worker was killed with SIGKILL", async () => {
    const stateDir = newStateDir();
    const crashed = startWorker(stateDir);
    await answering(stateDir, crashed);
    crashed.child.kill("SIGKILL");
    await crashed.exited;

    const next = startWorker(stateDir);
    await answering(stateDir, next);
    expect(readFileSync(join(stateDir, STATE_PID_NAME), "utf8").trim()).toBe(String(next.child.pid));
  }, 60_000);

  it("runs two workers side by side on different state directories", async () => {
    const one = newStateDir();
    const two = newStateDir();
    const first = startWorker(one);
    const second = startWorker(two);
    await answering(one, first);
    await answering(two, second);
    expect(alive(first.child) && alive(second.child)).toBe(true);
  }, 60_000);

  it.skipIf(process.platform !== "darwin")("cannot be held by a confined spawn that outlived its worker", async () => {
    const stateDir = newStateDir();
    const crashed = startWorker(stateDir);
    await answering(stateDir, crashed);
    crashed.child.kill("SIGKILL");
    await crashed.exited;

    const worktree = mkdtempSync(join(scratch, "worktree-"));
    const holder = confine(
      "/usr/bin/perl",
      [
        "-e",
        'use Fcntl qw(:flock); $|=1; for my $m ("<", ">>") { if (open(my $f, $m, $ARGV[0])) { if (flock($f, LOCK_EX|LOCK_NB)) { print "held\\n"; sleep 30 } } } print "refused\\n"',
        join(stateDir, STATE_LOCK_NAME),
      ],
      { writable: [worktree], env: {} }
    );
    if (!("command" in holder)) throw new Error(`refused: ${holder.refusal}`);
    const survivor = spawn(holder.command, holder.args, { cwd: worktree, stdio: ["ignore", "pipe", "ignore"] });
    started.push(survivor);
    const verdict = await new Promise<string>((resolve) => survivor.stdout?.once("data", (chunk) => resolve(String(chunk).trim())));
    expect(verdict).toBe("refused");

    const next = startWorker(stateDir);
    await answering(stateDir, next);
  }, 60_000);
});
