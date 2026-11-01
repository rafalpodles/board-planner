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
sys=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then prompt="$2"; shift; fi
  if [ "$1" = "--append-system-prompt" ]; then sys="$2"; shift; fi
  shift
done
case "$prompt" in
  *"[stall]"*) : > ${STALL_MARKER}; exec sleep 600 ;;
  *"[rewrite the gate]"*) printf 'exit 0\\n' > svc/check.sh ;;
esac
case "$sys" in
  *"spans several repositories"*)
    web=$(printf '%s\\n' "$sys" | sed -n 's/^- "smoke-web": //p')
    mkdir -p src test "$web/src" "$web/test"
    printf '%s\\n' 'module.exports = (name) => "Hello, " + name;' > src/greet.js
    printf '%s\\n' 'module.exports = (name) => "Goodbye, " + name;' > "$web/src/farewell.js"
    cat > test/greet.test.js <<'JS'
const test = require("node:test");
const assert = require("node:assert");
const greet = require("../src/greet.js");
test("greets by name", () => assert.strictEqual(greet("Ada"), "Hello, Ada"));
JS
    cat > "$web/test/farewell.test.js" <<'JS'
const test = require("node:test");
const assert = require("node:assert");
const farewell = require("../src/farewell.js");
test("says goodbye by name", () => assert.strictEqual(farewell("Ada"), "Goodbye, Ada"));
JS
    echo '{"type":"result","subtype":"success","is_error":false,"result":"{\\"status\\":\\"completed\\",\\"summary\\":\\"Added a greeting and a farewell\\",\\"filesChanged\\":[\\"src/greet.js\\"],\\"testsAdded\\":[\\"test/greet.test.js\\"],\\"blockedReason\\":\\"\\"}"}'
    exit 0 ;;
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
  "pr create") echo "https://github.com/e2e/$(basename "$(git config remote.origin.url)" .git)/pull/1" ;;
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

// BP-985. No package.json anywhere: what the gates run is these three scripts, under the real sandbox.
// The install leaves a file in its home for the build and the test, reaches off the machine, and proves
// the worker's home is shut to it. TEST-NET-1 is never routed, so an open network times out or fails on
// the route, where a closed one answers EPERM at once.
const NETWORK_OPEN = `require("net").connect({ host: "192.0.2.1", port: 443, timeout: 2000 }).on("error", (e) => process.exit(e.code === "EPERM" ? 1 : 0)).on("connect", () => process.exit(0)).on("timeout", () => process.exit(0))`;

function writeGateScripts(dir: string) {
  write(join(dir, "fetch.sh"), `set -e\nnode -e '${NETWORK_OPEN}'\nif cat '${join(HOME, ".profile")}'; then exit 1; fi\necho fetched > "$HOME/fetched"\n`);
  write(join(dir, "build.sh"), `set -e\ntest "$(cat "$HOME/fetched")" = fetched\ntop=$(git rev-parse --show-toplevel)\nfor f in "$top"/src/*.js; do node --check "$f"; done\n`);
  write(join(dir, "check.sh"), `set -e\ntest "$(cat "$HOME/fetched")" = fetched\ntop=$(git rev-parse --show-toplevel)\nnode --test "$top"/test/*.test.js\n`);
}

function layDownRepository(repo: string = REPO, gateScriptsIn?: string): string {
  const bare = join(GIT_ROOT, `${repo}.git`);
  const seedClone = join(ROOT, `seed-clone-${repo.replace(/\W+/g, "-")}`);
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "-q", "-b", "main");
  mkdirSync(seedClone, { recursive: true });
  git(seedClone, "init", "-q", "-b", "main");
  if (gateScriptsIn === undefined) {
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
  } else {
    writeGateScripts(join(seedClone, gateScriptsIn));
  }
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

function cloneCheckout(port: number, repo: string = REPO, into: string = CHECKOUT) {
  git(ROOT, "clone", "-q", `git://127.0.0.1:${port}/${repo}.git`, into);
  git(into, "config", "user.name", "BP-711 smoke");
  git(into, "config", "user.email", "smoke@example.test");
}

async function startDaemon(port: number, repo: string = REPO): Promise<ChildProcess> {
  const daemon = spawn(
    "git",
    ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", `--base-path=${GIT_ROOT}`, `--port=${port}`, "--listen=127.0.0.1", GIT_ROOT],
    { env: OWN_GIT_ENV, stdio: "ignore" }
  );
  try {
    await expect
      .poll(() => {
        try {
          execFileSync("git", ["ls-remote", `git://127.0.0.1:${port}/${repo}.git`], { env: OWN_GIT_ENV, stdio: "pipe" });
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
  // `close`, not `exit`: the log stream is flushed by then, so its last lines are in the dump and the attachment
  const exited = new Promise<void>((done) => child.once("close", () => done()));
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
  // The job log carries it even when the artifact upload fails (BP-1049)
  if (testInfo.status !== testInfo.expectedStatus && existsSync(WORKER_LOG)) {
    console.log(`--- worker.log, last 400 lines\n${readFileSync(WORKER_LOG, "utf8").split("\n").slice(-400).join("\n")}`);
  }
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

// BP-1073. One task, one project that lists two repositories: the worker takes it only with a checkout of
// each and says so in X-CP-Capabilities, runs the agent in one worktree per repository, passes the gates in
// both, pushes both and opens a pull request in each. The two checkouts sit in one parent directory, so
// their worktrees share a root, which is how an operator lays them out.
const API = { repo: "e2e/smoke-api", name: "smoke-api", id: new mongoose.Types.ObjectId() };
const WEB = { repo: "e2e/smoke-web", name: "smoke-web", id: new mongoose.Types.ObjectId() };
const SEVERAL = { id: new mongoose.Types.ObjectId(), number: 713, title: "Greet and say goodbye" };

test("the real worker runs one task in two repositories and opens a pull request in each", async ({ request }) => {
  await withDb(async (db) => {
    await db.collection("tasks").deleteMany({ _id: { $in: [DELIVERED.id, STOPPED.id] } });
    await db.collection("projects").updateOne(
      { _id: PROJECT_ID },
      {
        $set: {
          repositoryUrl: API.repo,
          repositories: [API, WEB].map((r) => ({ _id: r.id, url: r.repo, name: r.name })),
          taskCounter: SEVERAL.number,
        },
        $unset: { githubRepo: "", gitlabRepo: "" },
      }
    );
    await db.collection("tasks").insertOne(
      taskFactory(new Date())({
        _id: SEVERAL.id,
        taskNumber: SEVERAL.number,
        title: SEVERAL.title,
        status: "todo",
        order: 0,
        assignee: ADMIN_ID,
        assignedBy: ADMIN_ID,
        agent: AGENT_ID,
      })
    );
  });
  const bares = { api: layDownRepository(API.repo), web: layDownRepository(WEB.repo) };
  const port = await freePort();
  daemon = await startDaemon(port, API.repo);
  const checkouts = { api: join(ROOT, "checkout-api"), web: join(ROOT, "checkout-web") };
  cloneCheckout(port, API.repo, checkouts.api);
  cloneCheckout(port, WEB.repo, checkouts.web);
  write(join(STATE, "repos.json"), JSON.stringify({ repos: [checkouts.api, checkouts.web] }) + "\n", 0o600);

  worker = startWorker(await mintEnrolmentToken(request));

  const key = `${PROJECT_KEY}-${SEVERAL.number}`;
  await expect
    .poll(async () => (await storedTask(SEVERAL.id))?.status, {
      message: `${key} should reach the escalation review column; see worker.log`,
      timeout: 4 * 60_000,
      intervals: [2_000],
    })
    .toBe("needs_human_review");

  const delivered = await storedTask(SEVERAL.id);
  expect(delivered?.execution?.runId).toBeUndefined();
  expect(delivered?.execution?.attempts).toBe(1);
  const urls = [API, WEB].map((r) => `https://github.com/e2e/${r.name}/pull/1`);
  expect(await commentsOn(SEVERAL.id)).toContainEqual(expect.stringContaining(`Opened ${urls.join(", ")} for review`));

  const branch = `refs/heads/${key}/worker`;
  expect(git(bares.api, "ls-tree", "-r", "--name-only", branch).split("\n")).toEqual(expect.arrayContaining(["src/greet.js", "test/greet.test.js"]));
  expect(git(bares.web, "ls-tree", "-r", "--name-only", branch).split("\n")).toEqual(expect.arrayContaining(["src/farewell.js", "test/farewell.test.js"]));
  for (const bare of Object.values(bares)) {
    expect(git(bare, "rev-parse", `${branch}^`).trim()).toBe(git(bare, "rev-parse", "refs/heads/main").trim());
  }

  const ghCalls = readFileSync(GH_LOG, "utf8");
  expect(ghCalls.match(/^pr create /gm)).toHaveLength(2);
  // No visibility could be asked of a loopback git daemon, so neither description carries the agent's prose
  expect(ghCalls.match(/limited to this repository's own part/g)).toHaveLength(2);
  expect(ghCalls).not.toContain("Added a greeting and a farewell");
  // ...nor lists the other pull request, for the same reason
  expect(ghCalls).not.toContain("pr edit");
});

// BP-985. A repository with no package.json, on a machine with npm as ever: the real worker runs the
// project's own commands under the real sandbox, the pull request names them, the run's home goes with its
// worktree, and an agent that rewrites what a command runs is refused rather than passed.
const OWN = { id: new mongoose.Types.ObjectId(), number: 714, title: "Greet on own commands" };
const REWRITES = { id: new mongoose.Types.ObjectId(), number: 715, title: "Make the tests pass [rewrite the gate]" };
const OWN_COMMANDS = { installCommand: "sh fetch.sh", buildCommand: "sh build.sh", testCommand: "sh check.sh" };

async function onOwnCommands(tasks: { id: mongoose.Types.ObjectId; number: number; title: string }[], policy: Record<string, string>) {
  await withDb(async (db) => {
    await db.collection("tasks").deleteMany({ _id: { $in: [DELIVERED.id, STOPPED.id] } });
    await db.collection("projects").updateOne(
      { _id: PROJECT_ID },
      {
        $set: {
          ...Object.fromEntries(Object.entries(policy).map(([field, value]) => [`worker.policy.${field}`, value])),
          "worker.policyOverrides": Object.keys(policy),
          taskCounter: Math.max(...tasks.map((t) => t.number)),
        },
      }
    );
    await db.collection("tasks").insertMany(
      tasks.map((t, order) =>
        taskFactory(new Date())({ _id: t.id, taskNumber: t.number, title: t.title, status: "todo", order, assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent: AGENT_ID })
      )
    );
  });
}

const homesUnder = (root: string) =>
  existsSync(root) ? readdirSync(root, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".home")) : [];

test("the real worker runs a repository with no npm on the project's own commands, and refuses an agent that rewrites one", async ({ request }) => {
  await onOwnCommands([OWN, REWRITES], { ...OWN_COMMANDS, workingDirectory: "svc" });
  const bare = layDownRepository(REPO, "svc");
  const port = await freePort();
  daemon = await startDaemon(port);
  cloneCheckout(port);
  write(join(STATE, "repos.json"), JSON.stringify({ repos: [CHECKOUT] }) + "\n", 0o600);

  worker = startWorker(await mintEnrolmentToken(request));

  const key = `${PROJECT_KEY}-${OWN.number}`;
  await expect
    .poll(async () => (await storedTask(OWN.id))?.status, { message: `${key} should reach review; see worker.log`, timeout: 4 * 60_000, intervals: [2_000] })
    .toBe("needs_human_review");
  expect(await commentsOn(OWN.id)).toContainEqual(expect.stringContaining(`Opened ${PR_URL} for review`));
  expect(git(bare, "ls-tree", "-r", "--name-only", `refs/heads/${key}/worker`).split("\n")).toEqual(expect.arrayContaining(["src/greet.js", "svc/check.sh"]));

  const ghCalls = readFileSync(GH_LOG, "utf8");
  expect(ghCalls).toContain("`sh fetch.sh (in svc)`, `sh build.sh (in svc)`");
  expect(ghCalls).toContain("`sh check.sh (in svc)`");
  expect(ghCalls).not.toContain("npm");

  const rewritten = `${PROJECT_KEY}-${REWRITES.number}`;
  await expect
    .poll(async () => (await commentsOn(REWRITES.id)).join("\n"), { message: `${rewritten} should be refused; see worker.log`, timeout: 4 * 60_000, intervals: [2_000] })
    .toContain("svc/check.sh");
  expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n")).not.toContain(`refs/heads/${rewritten}/worker`);
  expect((await storedTask(REWRITES.id))?.decision?.protectedFiles).toEqual(["svc/check.sh"]);

  await expect.poll(() => homesUnder(join(ROOT, "cp-worktrees")).filter((path) => path.includes(`${OWN.number}.`)), { timeout: 30_000 }).toEqual([]);
});

// The first review of BP-985 found this by reading: two clones share a worktree root, so the second clone's
// creation took the first's home, and every such run ended as tampering at its first gate
test("the real worker runs a project's own commands in two repositories that share a worktree root", async ({ request }) => {
  const several = { id: new mongoose.Types.ObjectId(), number: 716, title: "Greet and say goodbye on own commands" };
  await onOwnCommands([several], OWN_COMMANDS);
  await withDb((db) =>
    db.collection("projects").updateOne(
      { _id: PROJECT_ID },
      { $set: { repositoryUrl: API.repo, repositories: [API, WEB].map((r) => ({ _id: r.id, url: r.repo, name: r.name })) }, $unset: { githubRepo: "", gitlabRepo: "" } }
    )
  );
  layDownRepository(API.repo, "");
  layDownRepository(WEB.repo, "");
  const port = await freePort();
  daemon = await startDaemon(port, API.repo);
  const checkouts = [join(ROOT, "checkout-api"), join(ROOT, "checkout-web")];
  cloneCheckout(port, API.repo, checkouts[0]);
  cloneCheckout(port, WEB.repo, checkouts[1]);
  write(join(STATE, "repos.json"), JSON.stringify({ repos: checkouts }) + "\n", 0o600);

  worker = startWorker(await mintEnrolmentToken(request));

  await expect
    .poll(async () => (await storedTask(several.id))?.status, { message: "the run should reach review; see worker.log", timeout: 4 * 60_000, intervals: [2_000] })
    .toBe("needs_human_review");
  expect((await commentsOn(several.id)).join("\n")).not.toMatch(/tamper|replaced/i);
  expect(readFileSync(GH_LOG, "utf8").match(/^pr create /gm)).toHaveLength(2);
});
