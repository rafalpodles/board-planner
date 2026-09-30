import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./env.js";
import { SANDBOX_COMMAND } from "./sandbox.js";

/**
 * Finds and kills every process that inherited a confined spawn's sandbox (BP-796).
 *
 * A process group is not enough: `setsid`, a double fork or `nohup … &` leaves the group and the
 * session and is reparented to launchd, and macOS has no cgroup to hold it. What such a process
 * cannot leave is its sandbox — children inherit it and a confined process cannot apply another
 * (`sandbox_apply: Operation not permitted`, measured on macOS 26.6). So every confined spawn's
 * profile denies a mach service name of its own, and a process carries that mark exactly when
 * `sandbox_check` says it is denied the name while a sibling name nobody mentions is allowed.
 * Unconfined processes allow both; App Sandbox processes, which deny by default, deny both.
 *
 * Two marks per spawn: one for the spawn, reaped when it ends, and one for this worker's state
 * directory, reaped when the worker starts — which is what reaches a survivor of a worker process
 * that crashed or was restarted, whose per-spawn marks died with it.
 *
 * Not covered: a program the spawn asks a daemon to start (`open`, LaunchServices) never had the
 * sandbox at all — BP-807.
 *
 * Node cannot call `sandbox_check`. Releases ship the helper built (`build-reaper.sh`); a clone
 * compiles it with `/usr/bin/cc`. Either way it is refused if a confined spawn could rewrite it, and
 * must find and kill a confined probe before it is trusted.
 */

export interface SpawnMarker {
  denied: string;
  control: string;
}

export type ReapOutcome = { ok: true; killed: number } | { ok: false; reason: string };

export interface Reaper {
  /** Empty when reaping works here and no path in `writable` reaches the helper, otherwise why not. */
  ready(writable: string[]): Promise<string>;
  reap(marker: SpawnMarker): Promise<ReapOutcome>;
}

export const SPAWN_MARK_PARAM = "CP_SPAWN_MARK";
export const WORKER_MARK_PARAM = "CP_WORKER_MARK";
const COMPILER = "/usr/bin/cc";
const HELPER_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

export const REAPER_SOURCE = String.raw`
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <time.h>
#include <unistd.h>

int sandbox_check(pid_t pid, const char *operation, int type, ...);

#define FILTER_GLOBAL_NAME 2
#define CHECK_NO_REPORT 0x40000000
#define MAX_PASSES 200

static int denies(pid_t pid, const char *name) {
  return sandbox_check(pid, "mach-lookup", FILTER_GLOBAL_NAME | CHECK_NO_REPORT, name);
}

// 1 live, 0 a zombie, -1 unreadable. The start time goes with the pid so a pid reused between the
// check and the kill is not the one killed.
static int identify(pid_t pid, uint64_t *started) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) != sizeof info) return -1;
  if (info.pbi_status == SZOMB) return 0;
  *started = info.pbi_start_tvsec * 1000000ULL + info.pbi_start_tvusec;
  return 1;
}

static int gone(pid_t pid) {
  return kill(pid, 0) == -1 && errno == ESRCH;
}

static int ours(pid_t pid, const char *marker, const char *control) {
  return denies(pid, marker) == 1 && denies(pid, control) == 0;
}

static int list(pid_t **pids, int *capacity) {
  for (;;) {
    int needed = proc_listallpids(NULL, 0);
    if (needed <= 0) return -1;
    if (needed * 2 > *capacity) {
      *capacity = needed * 2;
      *pids = realloc(*pids, sizeof(pid_t) * *capacity);
      if (!*pids) return -1;
    }
    int count = proc_listallpids(*pids, sizeof(pid_t) * *capacity);
    if (count <= 0) return -1;
    if (count < *capacity) return count;
  }
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: reap <marker> <control>\n");
    return 64;
  }
  pid_t self = getpid();
  int capacity = 0;
  pid_t *pids = NULL;
  long killed = 0;
  for (int pass = 1; pass <= MAX_PASSES; pass++) {
    int count = list(&pids, &capacity);
    if (count < 0) {
      fprintf(stderr, "cannot list processes: %s\n", strerror(errno));
      return 70;
    }
    int found = 0;
    for (int i = 0; i < count; i++) {
      pid_t pid = pids[i];
      if (pid <= 1 || pid == self) continue;
      int marked = denies(pid, argv[1]);
      int control = denies(pid, argv[2]);
      if ((marked < 0 || control < 0) && !gone(pid)) {
        fprintf(stderr, "cannot inspect the sandbox of process %d\n", pid);
        return 75;
      }
      if (marked != 1 || control != 0) continue;

      uint64_t before = 0, after = 0;
      int state = identify(pid, &before);
      if (state == 0 || (state < 0 && gone(pid))) continue;
      if (state < 0) {
        fprintf(stderr, "cannot inspect process %d, which carries this spawn's sandbox\n", pid);
        return 75;
      }
      found++;
      if (!ours(pid, argv[1], argv[2]) || identify(pid, &after) != 1 || after != before) continue;
      if (kill(pid, SIGKILL) == 0) {
        killed++;
      } else if (errno != ESRCH) {
        fprintf(stderr, "cannot kill process %d: %s\n", pid, strerror(errno));
        return 75;
      }
    }
    if (!found) {
      printf("%ld\n", killed);
      return 0;
    }
    struct timespec pause = {0, 2000000};
    nanosleep(&pause, NULL);
  }
  fprintf(stderr, "processes kept appearing after %d passes\n", MAX_PASSES);
  return 75;
}
`;

function markRule(param: string): string {
  return `(deny mach-lookup (global-name (param "${param}")))`;
}

function markerNamed(denied: string): SpawnMarker {
  return { denied, control: `${denied}.control` };
}

export function newMarker(): SpawnMarker {
  return markerNamed(`com.boardplanner.spawn.${randomUUID()}`);
}

/** Stable across restarts of one worker, and different for two workers of the same operator. */
export function workerMarkFor(stateDir: string): SpawnMarker {
  let path = resolve(stateDir);
  try {
    path = realpathSync(path);
  } catch {
    // not created yet; the resolved path is what a later run resolves to as well
  }
  return markerNamed(`com.boardplanner.worker.${createHash("sha256").update(path).digest("hex").slice(0, 32)}`);
}

/**
 * Adds the marks to the profile `confine` built. Anything but `-p <profile>` first is refused rather
 * than guessed at: a sandbox-exec spawn this cannot mark is one nothing could reap.
 */
export function markConfinedSpawn(
  args: string[],
  marker: SpawnMarker = newMarker(),
  workerMark?: SpawnMarker
): { args: string[]; marker: SpawnMarker } | { refusal: string } {
  if (args[0] !== "-p" || typeof args[1] !== "string") {
    return { refusal: `refusing to run ${SANDBOX_COMMAND} without an inline profile to mark` };
  }
  const rules = [markRule(SPAWN_MARK_PARAM), ...(workerMark ? [markRule(WORKER_MARK_PARAM)] : [])];
  const params = [
    "-D",
    `${SPAWN_MARK_PARAM}=${marker.denied}`,
    ...(workerMark ? ["-D", `${WORKER_MARK_PARAM}=${workerMark.denied}`] : []),
  ];
  return { args: ["-p", [args[1], ...rules].join("\n"), ...params, ...args.slice(2)], marker };
}

/** The absolute paths a sandbox-exec argument list makes writable. */
export function writableIn(args: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "-D") continue;
    const value = args[index + 1].slice(args[index + 1].indexOf("=") + 1);
    if (value.startsWith("/")) paths.push(value);
  }
  return paths;
}

interface Executed {
  code: number | null;
  stdout: string;
  stderr: string;
}

function execute(command: string, args: string[], input?: string): Promise<Executed> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), HELPER_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runHelper(helper: string, marker: SpawnMarker): Promise<ReapOutcome> {
  const result = await execute(helper, [marker.denied, marker.control]);
  const killed = Number.parseInt(result.stdout.trim(), 10);
  if (result.code === 0 && Number.isInteger(killed)) return { ok: true, killed };
  return { ok: false, reason: result.stderr.trim() || `the reaper exited ${result.code}` };
}

// Shown a confined sleeper and required to kill it: a macOS whose sandbox_check stopped answering
// would otherwise reap nothing and report success on every run.
async function proveHelper(helper: string): Promise<string> {
  const marker = newMarker();
  const marked = markConfinedSpawn(["-p", "(version 1)\n(allow default)", "/bin/sh", "-c", "echo ready; exec /bin/sleep 60"], marker);
  if ("refusal" in marked) return marked.refusal;

  const probe = spawn(SANDBOX_COMMAND, marked.args, { env: childEnv(), stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<void>((resolve) => probe.on("close", () => resolve()));
  const timer = setTimeout(() => probe.kill("SIGKILL"), PROBE_TIMEOUT_MS);
  try {
    const ready = await new Promise<boolean>((resolve) => {
      probe.stdout.setEncoding("utf8").once("data", () => resolve(true));
      probe.once("error", () => resolve(false));
      probe.once("exit", () => resolve(false));
    });
    if (!ready) return `the reaper's confined probe did not start under ${SANDBOX_COMMAND}`;

    const outcome = await runHelper(helper, marker);
    if (!outcome.ok) return outcome.reason;
    if (outcome.killed < 1) return "the reaper did not find the confined probe it was shown";
    return "";
  } finally {
    probe.kill("SIGKILL");
    await exited;
    clearTimeout(timer);
  }
}

function within(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

// The helper and its own directory are this uid's or root's alone. Above that it shares the trust of
// the worker's own code, which sits beside it — /Applications is group-writable by admin — so only a
// directory anyone may write to without the sticky bit is refused there.
export function untamperable(path: string, uid: number = process.getuid?.() ?? 0): string {
  let current: string;
  try {
    current = realpathSync(path);
  } catch (error) {
    return `cannot resolve the process reaper at ${path}: ${String(error)}`;
  }
  if (!lstatSync(current).isFile()) return `the process reaper at ${current} is not a regular file`;
  for (let depth = 0; ; depth++) {
    const entry = lstatSync(current);
    const strict = depth < 2;
    if (entry.uid !== uid && entry.uid !== 0) return `${current} belongs to another user, who could replace the process reaper`;
    const sticky = entry.isDirectory() && (entry.mode & 0o1000) !== 0;
    if ((entry.mode & (strict ? 0o022 : 0o002)) !== 0 && !sticky) {
      return `${current} is writable by others, who could replace the process reaper`;
    }
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

const APP_HELPER = /^(.*?\.app)\/Contents\/Resources\/worker\/bin\/cp-reap$/;

// Inside the app the helper is covered by the app's signature, so a helper changed after signing
// fails the seal rather than being run.
async function sealed(helper: string): Promise<string> {
  const app = APP_HELPER.exec(helper)?.[1];
  if (!app) return "";
  const verified = await execute("/usr/bin/codesign", ["--verify", "--strict", app]);
  return verified.code === 0 ? "" : `the app carrying the process reaper fails its signature: ${verified.stderr.trim()}`;
}

type Resolved = { helper: string } | { failure: string };

async function compileHelper(compiler: string): Promise<Resolved> {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "cp-reaper-"));
  } catch (error) {
    return { failure: `could not make a directory for the process reaper: ${String(error)}` };
  }
  const helper = join(dir, "reap");
  const compiled = await execute(compiler, ["-O2", "-x", "c", "-", "-o", helper], REAPER_SOURCE);
  if (compiled.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { failure: `could not build the process reaper with ${compiler}: ${compiled.stderr.trim() || `exit ${compiled.code}`}` };
  }
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return { helper };
}

async function resolveHelper(compiler: string, bundled: string): Promise<Resolved> {
  const found = existsSync(bundled) ? { helper: bundled } : await compileHelper(compiler);
  if ("failure" in found) return found;
  const failure = untamperable(found.helper) || (await sealed(realpathSync(found.helper))) || (await proveHelper(found.helper));
  return failure ? { failure } : { helper: realpathSync(found.helper) };
}

/** Where a release puts the built helper: beside this module, in the tarball and in the app. */
export function bundledHelperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "bin", "cp-reap");
}

export function createReaper({
  compiler = COMPILER,
  bundled = bundledHelperPath(),
}: { compiler?: string; bundled?: string } = {}): Reaper {
  let resolving: Promise<Resolved> | undefined;

  async function helper(): Promise<Resolved> {
    resolving ??= resolveHelper(compiler, bundled);
    const outcome = await resolving;
    if ("failure" in outcome) resolving = undefined;
    return outcome;
  }

  return {
    async ready(writable) {
      const outcome = await helper();
      if ("failure" in outcome) return outcome.failure;
      for (const path of writable) {
        let directory = path;
        try {
          directory = realpathSync(path);
        } catch {
          // confine resolves these before they get here; an unresolvable one is compared as given
        }
        if (within(outcome.helper, directory)) {
          return `refusing a confined spawn that could rewrite the process reaper at ${outcome.helper}`;
        }
      }
      return "";
    },
    async reap(marker) {
      const outcome = await helper();
      if ("failure" in outcome) return { ok: false, reason: outcome.failure };
      return runHelper(outcome.helper, marker);
    },
  };
}
