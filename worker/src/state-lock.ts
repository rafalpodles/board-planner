import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const STATE_LOCK_NAME = "worker.lock";
export const STATE_PID_NAME = "worker.pid";

// macOS open(2)'s flock-on-open flag, which Node exports no constant for; Linux ignores the bit
const O_EXLOCK = 0x20;
// Write-only, because flock needs nothing but an open descriptor: a confined spawn may read the state
// directory, and holding this lock from a survivor would keep the startup reap from ever running
const LOCK_MODE = 0o200;

export class StateDirBusy extends Error {
  constructor(
    readonly stateDir: string,
    readonly holder: number | null
  ) {
    super(
      `Another Board Planner worker${holder ? ` (pid ${holder})` : ""} is already running on ${stateDir}. ` +
        "Two workers on one state directory share one machine credential and kill each other's runs, " +
        "so this one is not starting. Stop the other worker, or give this one its own CP_STATE_DIR."
    );
    this.name = "StateDirBusy";
  }
}

function recordedHolder(stateDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(stateDir, STATE_PID_NAME), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function recordHolder(stateDir: string): void {
  const target = join(stateDir, STATE_PID_NAME);
  const staged = `${target}.${process.pid}`;
  rmSync(staged, { force: true });
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(staged, target);
}

function lockWithOpenFlag(stateDir: string): void {
  let fd: number;
  try {
    fd = openSync(
      join(stateDir, STATE_LOCK_NAME),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK,
      LOCK_MODE
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EAGAIN") throw new StateDirBusy(stateDir, recordedHolder(stateDir));
    throw error;
  }
  fchmodSync(fd, LOCK_MODE);
}

// Linux has no O_EXLOCK; the kernel unbinds an abstract socket when its process dies
async function lockWithAbstractSocket(stateDir: string): Promise<void> {
  const digest = createHash("sha256").update(realpathSync(stateDir)).digest("hex").slice(0, 32);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new StateDirBusy(stateDir, recordedHolder(stateDir)) : error)
    );
    server.listen(`\0cp-worker-${process.getuid?.() ?? 0}-${digest}`, () => resolve());
  });
  server.unref();
}

export async function lockStateDir(stateDir: string): Promise<void> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform === "linux") await lockWithAbstractSocket(stateDir);
  else lockWithOpenFlag(stateDir);
  recordHolder(stateDir);
}
