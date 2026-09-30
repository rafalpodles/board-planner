import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./env.js";
import { SANDBOX_COMMAND } from "./sandbox.js";

/**
 * Finds and kills every process a confined spawn left behind (BP-796).
 *
 * A process group is not enough: `setsid`, a double fork or `nohup … &` leaves the group and the
 * session and is reparented to launchd, and macOS has no cgroup to hold it. What such a process
 * cannot leave is its sandbox — children inherit it and a confined process cannot apply another
 * (`sandbox_apply: Operation not permitted`, measured on macOS 26.6). So every confined spawn gets a
 * rule naming a mach service of its own, denied, and a process belongs to that spawn exactly when
 * `sandbox_check` says it is denied that name while a sibling name nobody mentions is allowed.
 * Unconfined processes allow both; App Sandbox processes, which deny by default, deny both.
 *
 * Node cannot call `sandbox_check`, so the helper below is compiled once per worker with the
 * compiler git already needs. A machine where that fails runs no confined spawn at all.
 */

export interface SpawnMarker {
  denied: string;
  control: string;
}

export type ReapOutcome = { ok: true; killed: number } | { ok: false; reason: string };

export interface Reaper {
  /** Empty when reaping works on this machine, otherwise why it does not. */
  ready(): Promise<string>;
  reap(marker: SpawnMarker): Promise<ReapOutcome>;
}

export const MARK_PARAM = "CP_SPAWN_MARK";
const MARK_RULE = `(deny mach-lookup (global-name (param "${MARK_PARAM}")))`;
const COMPILER = "/usr/bin/cc";
const HELPER_TIMEOUT_MS = 60_000;

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

static int live(pid_t pid) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) != sizeof info) return 0;
  return info.pbi_status != SZOMB;
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
    int needed = proc_listallpids(NULL, 0);
    if (needed <= 0) {
      fprintf(stderr, "cannot list processes: %s\n", strerror(errno));
      return 70;
    }
    if (needed * 2 > capacity) {
      capacity = needed * 2;
      pids = realloc(pids, sizeof(pid_t) * capacity);
      if (!pids) return 71;
    }
    int count = proc_listallpids(pids, sizeof(pid_t) * capacity);
    if (count <= 0) {
      fprintf(stderr, "cannot list processes: %s\n", strerror(errno));
      return 70;
    }
    int found = 0;
    for (int i = 0; i < count; i++) {
      pid_t pid = pids[i];
      if (pid <= 1 || pid == self) continue;
      int marked = denies(pid, argv[1]);
      int control = denies(pid, argv[2]);
      if ((marked < 0 || control < 0) && live(pid)) {
        fprintf(stderr, "cannot inspect the sandbox of process %d\n", pid);
        return 75;
      }
      if (marked != 1 || control != 0 || !live(pid)) continue;
      found++;
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

export function newMarker(): SpawnMarker {
  const denied = `com.boardplanner.spawn.${randomUUID()}`;
  return { denied, control: `${denied}.control` };
}

/**
 * Adds a spawn's marker to the profile `confine` built. Anything but `-p <profile>` first is refused
 * rather than guessed at: a sandbox-exec spawn this cannot mark is one nothing could reap.
 */
export function markConfinedSpawn(
  args: string[],
  marker: SpawnMarker = newMarker()
): { args: string[]; marker: SpawnMarker } | { refusal: string } {
  if (args[0] !== "-p" || typeof args[1] !== "string") {
    return { refusal: `refusing to run ${SANDBOX_COMMAND} without an inline profile to mark` };
  }
  return {
    args: ["-p", `${args[1]}\n${MARK_RULE}`, "-D", `${MARK_PARAM}=${marker.denied}`, ...args.slice(2)],
    marker,
  };
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
  const ready = await new Promise<boolean>((resolve) => {
    probe.stdout.setEncoding("utf8").once("data", () => resolve(true));
    probe.once("error", () => resolve(false));
    probe.once("exit", () => resolve(false));
  });
  if (!ready) return `the reaper's confined probe did not start under ${SANDBOX_COMMAND}`;

  const outcome = await runHelper(helper, marker);
  if (!outcome.ok || outcome.killed < 1) {
    probe.kill("SIGKILL");
    await exited;
    return outcome.ok ? "the reaper did not find the confined probe it was shown" : outcome.reason;
  }
  await exited;
  return "";
}

async function buildHelper(compiler: string): Promise<{ helper: string } | { failure: string }> {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "cp-reaper-"));
  } catch (error) {
    return { failure: `could not make a directory for the process reaper: ${String(error)}` };
  }
  const helper = join(dir, "reap");
  const compiled = await execute(compiler, ["-O2", "-x", "c", "-", "-o", helper], REAPER_SOURCE);
  const failure =
    compiled.code !== 0
      ? `could not build the process reaper with ${compiler}: ${compiled.stderr.trim() || `exit ${compiled.code}`}`
      : await proveHelper(helper);
  if (failure) {
    rmSync(dir, { recursive: true, force: true });
    return { failure };
  }
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return { helper };
}

export function createReaper({ compiler = COMPILER }: { compiler?: string } = {}): Reaper {
  let built: Promise<{ helper: string } | { failure: string }> | undefined;

  async function helper(): Promise<{ helper: string } | { failure: string }> {
    built ??= buildHelper(compiler);
    const outcome = await built;
    if ("failure" in outcome) built = undefined;
    return outcome;
  }

  return {
    async ready() {
      const outcome = await helper();
      return "failure" in outcome ? outcome.failure : "";
    },
    async reap(marker) {
      const outcome = await helper();
      if ("failure" in outcome) return { ok: false, reason: outcome.failure };
      return runHelper(outcome.helper, marker);
    },
  };
}
