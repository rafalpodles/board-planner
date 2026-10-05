/**
 * BP-711: the real worker process (`worker/dist/main.js`) against the e2e app. It enrols with an
 * enrolment token, binds a checkout through `repos.json`, claims a task, runs it, pushes, opens a
 * pull request and reports — then a second run is stopped from the board, which is what makes the
 * worker call `POST …/tasks/[taskId]/release`. Every other worker spec hand-writes the HTTP the
 * worker would send.
 *
 * Replaced, and nothing else: `claude` and `gh` are shell stubs found by the worker's own tool
 * resolution (a login shell reading `$HOME/.profile`), and the remote is a `git daemon` on
 * loopback, because delivery refuses the `file` transport. The stub still runs under the worker's
 * seatbelt profile, so this job is macOS-only.
 *
 * Decision (BP-711): the worker gets a live path, in a job of its own outside the six e2e
 * groups; the menubar stays on its Swift unit tests and the contract tests, because
 * driving a UI app against a server needs macOS UI automation and this smoke already covers the
 * protocol the menubar wraps.
 *
 * Everything lives under e2e/.artifacts/ws, never under the real HOME. Not under the OS
 * temp directory: the worker refuses a checkout under /tmp or /private/var.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import mongoose from "mongoose";
import { BASE_URL } from "../../playwright.config";
import { SAME_ORIGIN } from "../api";
import { ADMIN_ID, ADMIN_SESSION_TOKEN, E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed, taskFactory } from "../seed";

test.skip(process.platform !== "darwin", "the worker confines its agent with seatbelt, which is macOS only");
test.describe.configure({ timeout: 8 * 60_000 });

const WORKER_DIR = resolve(__dirname, "..", "..", "worker");
const ARTIFACTS = resolve(__dirname, "..", ".artifacts");
const ROOT = join(ARTIFACTS, "ws");
const HOME = join(ROOT, "home");
const BIN = join(ROOT, "bin");
const STATE = join(ROOT, "state");
const GIT_ROOT = join(ROOT, "git");
const CHECKOUT = join(ROOT, "checkout");
const GH_LOG = join(ROOT, "gh.log");
const WORKER_LOG = join(ROOT, "worker.log");
const REPO = "e2e/smoke";
const WORKER_NAME = "bp-711-smoke";

const AGENT_ID = new mongoose.Types.ObjectId();
const DELIVERED = { id: new mongoose.Types.ObjectId(), number: 711, title: "Add a greeting" };
const STOPPED = { id: new mongoose.Types.ObjectId(), number: 712, title: "Wait until stopped [stall]" };
const STALL_MARKER = ".bp711-agent-started";
const PR_URL = `https://github.com/${REPO}/pull/1`;

const SESSION = { ...SAME_ORIGIN, Cookie: `__Host-bp_session=${ADMIN_SESSION_TOKEN}` };

const CLAUDE_STUB = `#!/bin/sh
case "$1" in
  --version) echo "2.1.999 (Claude Code stub)"; exit 0 ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"smoke@example.test","subscriptionType":"max"}'; exit 0 ;;
esac
prompt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then prompt="$2"; shift; fi
  shift
done
case "$prompt" in
  *"[stall]"*) : > ${STALL_MARKER}; exec sleep 600 ;;
esac
mkdir -p src test
printf '%s\\n' 'module.exports = (name) => "Hello, " + name;' > src/greet.js
cat > test/greet.test.js <<'JS'
const test = require("node:test");
const assert = require("node:assert");
const greet = require("../src/greet.js");
test("greets by name", () => assert.strictEqual(greet("Ada"), "Hello, Ada"));
JS
echo '{"type":"result","subtype":"success","is_error":false,"result":"{\\"status\\":\\"completed\\",\\"summary\\":\\"Added a greeting\\",\\"filesChanged\\":[\\"src/greet.js\\"],\\"testsAdded\\":[\\"test/greet.test.js\\"],\\"blockedReason\\":\\"\\"}"}'
`;

const GH_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> '${GH_LOG}'
case "$1 $2" in
  "--version "*) echo "gh version 2.99.0 (stub)" ;;
  "auth status") echo "github.com"; echo "  Logged in to github.com account e2e-smoke (keyring)"; echo "  - Active account: true" ;;
  "pr create") echo "${PR_URL}" ;;
  *) echo "gh stub: unsupported: $*" >&2; exit 1 ;;
esac
`;

// Our own git calls read neither the operator's ~/.gitconfig nor /etc/gitconfig
const OWN_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "BP-711 smoke",
  GIT_AUTHOR_EMAIL: "smoke@example.test",
  GIT_COMMITTER_NAME: "BP-711 smoke",
  GIT_COMMITTER_EMAIL: "smoke@example.test",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: OWN_GIT_ENV, encoding: "utf8", stdio: "pipe" });
}

function write(path: string, text: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await fn(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

const storedTask = (id: mongoose.Types.ObjectId) =>
  withDb((db) => db.collection("tasks").findOne({ _id: id })) as Promise<Record<string, any> | null>;

const commentsOn = (id: mongoose.Types.ObjectId) =>
  withDb(async (db) => (await db.collection("comments").find({ task: id }).sort({ createdAt: 1 }).toArray()).map((c) => String(c.body)));

async function seedBoard() {
  await seed();
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const { seedAgents } = await import("@/lib/agent-seed");
    const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
    await seedAgents(scopedToDefaultOrganisation());
    const db = mongoose.connection.db!;
    const now = new Date();
    await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { githubRepo: REPO } });
    await db.collection("agents").insertOne({
      _id: AGENT_ID,
      name: "Smoke, stops at the pull request",
      description: "",
      scope: "project",
      owner: null,
      project: PROJECT_ID,
      builtIn: false,
      composition: {
        analysis: [],
        implementation: [{ key: "implement" }],
        verification: [
          { key: "protected-paths" },
          { key: "diff-size" },
          { key: "test-presence" },
          { key: "build" },
          { key: "test-run" },
        ],
        delivery: [{ key: "push" }, { key: "pull-request" }],
      },
      createdAt: now,
      updatedAt: now,
    });
    const task = taskFactory(now);
    await db.collection("tasks").insertMany(
      [DELIVERED, STOPPED].map((t, order) =>
        task({
          _id: t.id,
          taskNumber: t.number,
          title: t.title,
          status: "todo",
          order,
          assignee: ADMIN_ID,
          assignedBy: ADMIN_ID,
          agent: AGENT_ID,
        })
      )
    );
    await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: STOPPED.number } });
  } finally {
    await mongoose.disconnect();
  }
}

function layDownRepository(): string {
  const bare = join(GIT_ROOT, `${REPO}.git`);
  const seedClone = join(ROOT, "seed-clone");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "-q", "-b", "main");
  mkdirSync(seedClone, { recursive: true });
  git(seedClone, "init", "-q", "-b", "main");
  write(
    join(seedClone, "package.json"),
    JSON.stringify(
      { name: "smoke", version: "1.0.0", private: true, scripts: { build: "node --check src/index.js", test: "node --test test/*.test.js" } },
      null,
      2
    ) + "\n"
  );
  write(
    join(seedClone, "package-lock.json"),
    JSON.stringify({ name: "smoke", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "smoke", version: "1.0.0" } } }, null, 2) + "\n"
  );
  write(join(seedClone, ".gitignore"), "node_modules/\n");
  write(join(seedClone, "src", "index.js"), "module.exports = {};\n");
  write(
    join(seedClone, "test", "index.test.js"),
    'const test = require("node:test");\ntest("loads", () => require("../src/index.js"));\n'
  );
  git(seedClone, "add", ".");
  git(seedClone, "commit", "-q", "-m", "initial");
  git(seedClone, "push", "-q", bare, "main");
  return bare;
}

function cloneCheckout(port: number) {
  git(ROOT, "clone", "-q", `git://127.0.0.1:${port}/${REPO}.git`, CHECKOUT);
  git(CHECKOUT, "config", "user.name", "BP-711 smoke");
  git(CHECKOUT, "config", "user.email", "smoke@example.test");
}

async function startDaemon(port: number): Promise<ChildProcess> {
  const daemon = spawn(
    "git",
    ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", `--base-path=${GIT_ROOT}`, `--port=${port}`, "--listen=127.0.0.1", GIT_ROOT],
    { env: OWN_GIT_ENV, stdio: "ignore" }
  );
  try {
    await expect
      .poll(() => {
        try {
          execFileSync("git", ["ls-remote", `git://127.0.0.1:${port}/${REPO}.git`], { env: OWN_GIT_ENV, stdio: "pipe" });
          return true;
        } catch {
          return false;
        }
      }, { timeout: 15_000 })
      .toBe(true);
  } catch (error) {
    daemon.kill();
    throw error;
  }
  return daemon;
}

async function mintEnrolmentToken(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/workers/enrolment", { headers: SESSION, data: { label: WORKER_NAME } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).token;
}

function startWorker(enrolmentToken: string): ChildProcess {
  const env: Record<string, string> = {
    HOME,
    USER: process.env.USER ?? "smoke",
    LANG: "en_US.UTF-8",
    SHELL: "/bin/sh",
    PATH: `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: join(ROOT, "tmp"),
    XDG_CONFIG_HOME: join(HOME, ".config"),
    GH_CONFIG_DIR: join(HOME, ".config", "gh"),
    CP_API_URL: BASE_URL,
    CP_ENROLMENT_TOKEN: enrolmentToken,
    CP_WORKER_NAME: WORKER_NAME,
    CP_STATE_DIR: STATE,
    CP_NPM_CACHE: join(ROOT, "npm-cache"),
  };
  const log = createWriteStream(WORKER_LOG);
  const worker = spawn(process.execPath, [join(WORKER_DIR, "dist", "main.js")], {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout!.pipe(log);
  worker.stderr!.pipe(log);
  return worker;
}

async function stop(child: ChildProcess | undefined, graceMs: number) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

let worker: ChildProcess | undefined;
let daemon: ChildProcess | undefined;

test.beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: WORKER_DIR, stdio: "pipe" });
});

test.beforeEach(async () => {
  expect(ROOT.startsWith(`${ARTIFACTS}/`)).toBe(true);
  // Past 103 bytes the worker moves its socket to /tmp, outside this directory
  expect(Buffer.byteLength(join(STATE, "worker.sock")), "check this repository out at a shorter path").toBeLessThanOrEqual(103);
  rmSync(ROOT, { recursive: true, force: true });
  for (const dir of [HOME, BIN, join(ROOT, "tmp"), join(ROOT, "npm-cache")]) mkdirSync(dir, { recursive: true });
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  write(join(BIN, "claude"), CLAUDE_STUB, 0o755);
  write(join(BIN, "gh"), GH_STUB, 0o755);
  write(join(HOME, ".profile"), `export PATH="${BIN}:${dirname(process.execPath)}:$PATH"\n`);
  await seedBoard();
});

test.afterEach(async ({}, testInfo) => {
  await stop(worker, 30_000);
  await stop(daemon, 5_000);
  worker = daemon = undefined;
  if (existsSync(WORKER_LOG)) await testInfo.attach("worker.log", { path: WORKER_LOG });
  if (existsSync(GH_LOG)) await testInfo.attach("gh.log", { path: GH_LOG });
});

test("the real worker claims, runs, delivers and reports a task, and releases the one it is told to stop", async ({ request }) => {
  const bare = layDownRepository();
  const port = await freePort();
  daemon = await startDaemon(port);
  cloneCheckout(port);
  write(join(STATE, "repos.json"), JSON.stringify({ repos: [CHECKOUT] }) + "\n", 0o600);

  worker = startWorker(await mintEnrolmentToken(request));

  const deliveredKey = `${PROJECT_KEY}-${DELIVERED.number}`;
  await expect
    .poll(async () => (await storedTask(DELIVERED.id))?.status, {
      message: `${deliveredKey} should reach the escalation review column; see worker.log`,
      timeout: 4 * 60_000,
      intervals: [2_000],
    })
    .toBe("needs_human_review");

  const delivered = await storedTask(DELIVERED.id);
  expect(delivered?.execution?.runId).toBeUndefined();
  expect(delivered?.execution?.attempts).toBe(1);
  expect(await commentsOn(DELIVERED.id)).toContainEqual(expect.stringContaining(`Opened ${PR_URL} for review`));

  const branch = `refs/heads/${deliveredKey}/worker`;
  expect(git(bare, "ls-tree", "-r", "--name-only", branch).split("\n")).toEqual(
    expect.arrayContaining(["src/greet.js", "test/greet.test.js", "package.json"])
  );
  expect(git(bare, "rev-parse", `${branch}^`).trim()).toBe(git(bare, "rev-parse", "refs/heads/main").trim());
  const ghCalls = readFileSync(GH_LOG, "utf8");
  expect(ghCalls).toContain(`pr create --title ${deliveredKey}: ${DELIVERED.title} --body Added a greeting`);
  expect(ghCalls).toMatch(/- \*\*test-run\*\*: `npm test`.* --base main\n/);

  await expect
    .poll(async () => (await storedTask(STOPPED.id))?.execution?.runId, { timeout: 60_000 })
    .toEqual(expect.any(String));
  const worktrees = join(ROOT, "cp-worktrees");
  await expect
    .poll(
      () =>
        existsSync(worktrees) &&
        readdirSync(worktrees, { recursive: true, encoding: "utf8" }).some((path) => path.endsWith(STALL_MARKER)),
      { message: "the stub agent should be running the stopped task", timeout: 60_000 }
    )
    .toBe(true);
  const held = await storedTask(STOPPED.id);
  expect(held?.status).toBe("in_progress");
  expect(held?.execution?.attempts).toBe(1);

  const workerId = (await withDb((db) => db.collection("workers").findOne({ name: WORKER_NAME })))?._id;
  expect(workerId).toBeTruthy();
  const command = await request.post(`/api/workers/${workerId}/command`, { headers: SESSION, data: { command: "stop" } });
  expect(command.status(), await command.text()).toBe(200);

  await expect
    .poll(async () => (await storedTask(STOPPED.id))?.status, {
      message: "the stopped task should be handed back to the approved column",
      timeout: 2 * 60_000,
      intervals: [1_000],
    })
    .toBe("todo");
  const released = await storedTask(STOPPED.id);
  expect(released?.execution?.runId).toBeUndefined();
  expect(released?.execution?.attempts).toBe(0);
  expect(await commentsOn(STOPPED.id)).toContainEqual(expect.stringContaining("Returned to the queue: the run was stopped"));
});
