import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { agentArgs, answerSandboxProbe, isAgentSpawn, isSandboxProbe } from "./__fixtures__/agent-spawn.js";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { CommandResult, Runner, RunOpts } from "./exec.js";
import { createWorker } from "./wiring.js";

/**
 * BP-381, the seam. `decisions.ts` is unit-tested and so is `pipeline.ts`, but both halves being
 * right proves nothing about their being connected: the wiring is where `openDecision` reaches the
 * pipeline, where `parseDecisions` reaches `settleDecisions`, and where `heldTaskKeys` reaches the
 * reaper. Dropping any one of those is a change no unit test in this package can see.
 *
 * Real: api.ts, wiring.ts, the pipeline and every module it drives, the marker store on disk, the
 * identity on disk. Stubbed: the Runner — no git, gh or claude process is spawned — and the board,
 * which is a hand-written HTTP surface answering the way the real routes do.
 *
 * Two runs against one board and one state directory, because that is what the feature is: a run
 * that refuses and writes the record, then — after a person has answered — the next poll of the
 * same machine, which pushes. `refreshServerState` is floored at 30 seconds, so a second process
 * is also the only honest way to get a second refresh.
 */

const PROJECT_ID = "6512f0a1b2c3d4e5f6a70001";
const TASK_ID = "6512f0a1b2c3d4e5f6a70002";
const WORKER_ID = "6512f0a1b2c3d4e5f6a70003";
const ENROLMENT_TOKEN = "cpe_single_use_enrolment";
const MINTED_CREDENTIAL = "cpw_minted_by_the_board";
// A real directory, not a name. Since BP-349 the agent is confined to its worktree and seatbelt is
// given the resolved path, so a worktree that exists only in the stub's answers cannot be confined
// to — the run would fail for that rather than for the reason each test is about. The worktree root
// the worker derives sits beside this, so one temp root covers both.
const REPO_ROOT = mkdtempSync(join(tmpdir(), "bp381-repo-"));
const REPO = join(REPO_ROOT, "demo");
const REMOTE = "git@github.com:owner/repo.git";
const TOOL_DIR = "/opt/cp-integration-bin";
const BASE_SHA = "cafef00dcafef00dcafef00dcafef00dcafef00d";
const HEAD_SHA = "1234567812345678123456781234567812345678";
const TASK_KEY = "CP-9";
const BRANCH = "cp-9/worker";
const PR_URL = "https://github.com/owner/repo/pull/42";
const PATCH = 'diff --git a/package.json b/package.json\n+  "build": "next build"\n';

// The shortest agent that reaches the gate: write, then judge.
const CLAIMED_AGENT = {
  agentId: "6512f0a1b2c3d4e5f6a70004",
  name: "Default",
  sequence: [
    { key: "implement", kind: "step", name: "Implement", prompt: "do it", capability: "edit" },
    { key: "protected-paths", kind: "gate", name: "Protected files", gateKind: "protected-paths" },
    { key: "push", kind: "step", name: "Push", deterministic: true },
  ],
};

const SEEDED_COLUMNS = [
  { id: "todo", role: "approved", order: 1, triggersPmReview: false },
  { id: "in_progress", role: "active", order: 2, triggersPmReview: false },
  { id: "needs_human_review", role: "review", order: 3, triggersPmReview: true },
  { id: "done", role: "done", order: 4, triggersPmReview: false },
];

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface StoredDecision extends Record<string, unknown> {
  state: string;
}

function startBoard() {
  const calls: string[] = [];
  const comments: string[] = [];
  const statuses: string[] = [];
  const unauthorized: string[] = [];
  const settlements: Record<string, unknown>[] = [];
  let decision: StoredDecision | null = null;
  let claimed = false;

  function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? "").split("?")[0];
      const method = request.method ?? "";
      const body = await readBody(request);
      calls.push(`${method} ${path}`);

      if (method === "POST" && path === "/api/workers/register") {
        if (request.headers.authorization !== `Bearer ${ENROLMENT_TOKEN}`) {
          unauthorized.push(`${method} ${path}`);
          json(response, 401, { error: "unauthorized" });
          return;
        }
        json(response, 200, {
          workerId: WORKER_ID,
          credential: MINTED_CREDENTIAL,
          heartbeatMs: 600_000,
        });
        return;
      }

      if (
        request.headers.authorization !== `Bearer ${MINTED_CREDENTIAL}` ||
        request.headers["x-worker-id"] !== WORKER_ID ||
        (path.startsWith("/api/workers/") && !path.startsWith(`/api/workers/${WORKER_ID}`))
      ) {
        unauthorized.push(`${method} ${path}`);
        json(response, 401, { error: "unauthorized" });
        return;
      }

      // src/app/api/workers/[workerId]/decisions/route.ts
      if (path === `/api/workers/${WORKER_ID}/decisions`) {
        if (method === "POST") {
          decision = { ...body, state: "pending" };
          json(response, 201, { state: "pending" });
          return;
        }
        if (method === "PATCH") {
          settlements.push(body);
          if (decision) decision.state = String(body.state);
          json(response, 200, { state: body.state });
          return;
        }
      }

      if (method === "GET" && path === `/api/workers/${WORKER_ID}`) {
        // src/lib/task-decisions.ts decisionsForWorker: everything not settled, pending included
        const settled = ["delivered", "discarded", "abandoned", "superseded"];
        const live =
          decision && !settled.includes(decision.state)
            ? [
                {
                  taskId: TASK_ID,
                  projectId: PROJECT_ID,
                  taskKey: decision.taskKey,
                  title: decision.title,
                  commit: decision.commit,
                  patchSha256: decision.patchSha256,
                  state: decision.state,
                  attempts: 0,
                },
              ]
            : [];
        json(response, 200, {
          assignments: [{ project: PROJECT_ID, remote: REMOTE }],
          decisions: live,
        });
        return;
      }

      if (method === "POST" && path === `/api/workers/${WORKER_ID}/heartbeat`) {
        json(response, 200, {});
        return;
      }

      if (method === "GET" && path === `/api/workers/${WORKER_ID}/stream`) {
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        response.flushHeaders();
        return;
      }

      if (method === "POST" && path === `/api/workers/${WORKER_ID}/events`) {
        json(response, 200, { applied: true });
        return;
      }

      if (method === "GET" && path === `/api/projects/${PROJECT_ID}`) {
        json(response, 200, { key: "CP", columns: SEEDED_COLUMNS });
        return;
      }

      if (method === "POST" && path === `/api/projects/${PROJECT_ID}/tasks/claim`) {
        if (claimed) {
          response.writeHead(204).end();
          return;
        }
        claimed = true;
        json(response, 200, {
          _id: TASK_ID,
          project: PROJECT_ID,
          taskNumber: 9,
          title: "Add a thing",
          description: "body",
          checklist: [{ text: "it works" }],
          execution: { attempts: 1, runId: "run-minted-by-the-board" },
          agent: CLAIMED_AGENT,
        });
        return;
      }

      if (path.startsWith(`/api/projects/${PROJECT_ID}/tasks/${TASK_ID}/`)) {
        if (path.endsWith("/comments")) comments.push(String(body.body ?? ""));
        if (path.endsWith("/status")) statuses.push(String(body.status ?? ""));
        json(response, 200, {});
        return;
      }

      json(response, 404, { error: "not found" });
    })();
  });

  return {
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    /** What a person pressing Accept does to the record. */
    accept(): void {
      if (decision) decision.state = "accepted";
    },
    decision: () => decision,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    calls,
    comments,
    statuses,
    settlements,
    unauthorized,
  };
}

const RESULT_LINE = `${JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: JSON.stringify({
    status: "completed",
    summary: "edited the manifest",
    filesChanged: ["package.json"],
    testsAdded: [],
    blockedReason: "",
  }),
})}\n`;

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

interface GitCall {
  command: string;
  args: string[];
}

function makeRunner(seen: GitCall[], registeredWorktree = ""): Runner {
  return {
    async run(command, args, runOpts: RunOpts) {
      seen.push({ command, args });

      // BP-349 confines the agent to its worktree, and seatbelt is given the resolved path — so a
      // worktree that exists only in this stub's answers cannot be confined to, and the run fails
      // for that instead of for the reason under test. git is stubbed here, so the directory it
      // would have made is made here.
      if (command === "git" && args.includes("worktree") && args.includes("add")) {
        const separator = args.indexOf("--");
        if (separator !== -1 && args[separator + 1]) mkdirSync(args[separator + 1], { recursive: true });
      }

      if (args[0] === "-lc") return ok(`${TOOL_DIR}/${(args[1] ?? "").split(" ").pop() ?? ""}`);
      if (args[0] === "--version") return ok("1.0.0");
      if (args[0] === "auth" && args[1] === "status") {
        return ok(
          args.includes("--json")
            ? JSON.stringify({
                loggedIn: true,
                authMethod: "session",
                email: "worker@example.com",
                subscriptionType: "max",
              })
            : ""
        );
      }
      // Before the agent branch: both go through sandbox-exec, and the probe is the one wrapping sh.
      // A machine whose sandbox row is red claims nothing at all since BP-349, so without this the
      // worker never reaches the run these tests are about.
      if (isSandboxProbe(command, args)) {
        answerSandboxProbe(args);
        return ok();
      }
      if (isAgentSpawn(command, args)) {
        runOpts.onStdout?.(RESULT_LINE);
        return ok(RESULT_LINE);
      }

      // gh pr create, for the settlement's own delivery
      if (command === "gh" && args.includes("create")) return ok(`${PR_URL}\n`);

      if (args[0] === "ls-remote") return ok(`${BASE_SHA}\t${args[args.length - 1]}\n`);

      // The branch ref the settlement reads — not HEAD, because a linked worktree shares the ref
      // store with the main clone
      if (args.includes("--verify") && args.some((a) => a === `refs/heads/${BRANCH}`)) {
        return ok(`${HEAD_SHA}\n`);
      }
      // What collectDiff resolves the change to
      if (args.includes("--verify") && args.some((a) => a.startsWith("HEAD^"))) {
        return ok(`${HEAD_SHA}\n`);
      }
      if (args.includes("--verify")) return ok(`${BASE_SHA}\n`);

      if (args.includes("diff") && args.includes("--numstat")) return ok("1\t0\tpackage.json\n");
      if (args.includes("diff") && args.includes("--raw")) return ok("");
      if (args.includes("diff")) return ok(PATCH);

      // workspace.destroy only removes a worktree git says it has, so the settlement's cleanup is
      // reachable only once this answers with one
      if (args.includes("worktree") && args.includes("list")) {
        return ok(registeredWorktree ? `worktree ${registeredWorktree}\n` : "");
      }
      if (args.includes("status")) return ok("");
      if (args.includes("get-url")) return ok(REMOTE);
      if (args.includes("rev-parse")) return ok(REPO);
      return ok();
    },
  };
}

async function runOnePass(
  stateDir: string,
  apiBaseUrl: string,
  registeredWorktree = ""
): Promise<{ errors: string[]; git: GitCall[] }> {
  const errors: string[] = [];
  const git: GitCall[] = [];
  let stop = (): void => {};
  const worker = createWorker({
    env: {
      CP_API_URL: apiBaseUrl,
      CP_WORKER_NAME: "integration-worker",
      CP_ENROLMENT_TOKEN: ENROLMENT_TOKEN,
      CP_STATE_DIR: stateDir,
      HOME: stateDir,
    },
    runner: makeRunner(git, registeredWorktree),
    sleep: async () => stop(),
    log: () => {},
    logError: (message) => errors.push(message),
    uid: 501,
    realpath: (path) => path,
    stat: () => ({ uid: 501, mode: 0o40700 }),
    readFile: (path) =>
      path.endsWith("package.json")
        ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
        : path.endsWith("package-lock.json")
          ? "{}"
          : null,
    setPath: () => {},
  });
  stop = () => worker.shutdown();
  await worker.run();
  return { errors, git };
}

describe("a refused change, offered and then accepted, over a real HTTP surface", () => {
  let stateDir: string;
  let board: ReturnType<typeof startBoard>;
  let refusal: { errors: string[]; git: GitCall[] };
  let settlement: { errors: string[]; git: GitCall[] };
  let markerAfterRefusal: string | null;
  // Snapshotted rather than read at assertion time: the board's record is one mutable object, and
  // by the end of the second pass it says `delivered`
  let recordWhenOpened: Record<string, unknown> | null = null;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "bp381-int-"));
    writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: [REPO] }), { mode: 0o600 });
    board = startBoard();
    const apiBaseUrl = await board.listen();

    refusal = await runOnePass(stateDir, apiBaseUrl);

    const markerPath = join(stateDir, "decisions", `${TASK_KEY}.json`);
    markerAfterRefusal = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null;
    recordWhenOpened = { ...(board.decision() ?? {}) };

    // What a person pressing Accept does. The machine hears it on its next poll.
    board.accept();
    settlement = await runOnePass(
      stateDir,
      apiBaseUrl,
      markerAfterRefusal ? (JSON.parse(markerAfterRefusal).worktreePath as string) : ""
    );

    await board.close();
  }, 60_000);

  afterAllCleanup();

  function afterAllCleanup() {
    // rmSync in an afterAll would race the beforeAll above on a failure; this runs once the suite
    // has finished reading everything it captured.
    process.once("exit", () => {
      try {
        rmSync(stateDir, { recursive: true, force: true });
        rmSync(REPO_ROOT, { recursive: true, force: true });
      } catch {
        // a leftover temp directory is not worth failing a suite over
      }
    });
  }

  // Preconditions, asserted rather than assumed
  it("refuses the change at the gate and does not push it", () => {
    expect(board.unauthorized).toEqual([]);
    expect(board.calls).toContain(`POST /api/projects/${PROJECT_ID}/tasks/claim`);
    expect(refusal.git.some((call) => call.args.includes("push"))).toBe(false);
    expect(board.comments.join("\n")).toContain("protected-paths");
  });

  it("opens the decision on the worker's own route, naming the commit that was judged", () => {
    expect(board.calls).toContain(`POST /api/workers/${WORKER_ID}/decisions`);
    expect(recordWhenOpened).toMatchObject({
      taskKey: TASK_KEY,
      commit: HEAD_SHA,
      gate: "protected-paths",
      files: ["package.json"],
      protectedFiles: ["package.json"],
      acceptable: true,
      state: "pending",
    });
  });

  // Before the report that sends somebody to look at it
  it("writes the record before the board comment", () => {
    const record = board.calls.indexOf(`POST /api/workers/${WORKER_ID}/decisions`);
    const comment = board.calls.indexOf(
      `POST /api/projects/${PROJECT_ID}/tasks/${TASK_ID}/comments`
    );

    expect(record).toBeGreaterThanOrEqual(0);
    expect(comment).toBeGreaterThan(record);
  });

  /**
   * The marker is what holds the worktree back from `reapOrphans`, and it carries the two things
   * the server deliberately does not store — the base the patch was taken against, and where the
   * checkout is.
   */
  it("leaves a marker on disk carrying what the settlement will need", () => {
    expect(markerAfterRefusal).not.toBeNull();
    expect(JSON.parse(markerAfterRefusal!)).toMatchObject({
      taskKey: TASK_KEY,
      projectId: PROJECT_ID,
      commit: HEAD_SHA,
      baseSha: BASE_SHA,
    });
  });

  it("pushes the accepted commit by name on the next poll, and opens a pull request", () => {
    const push = settlement.git.find((call) => call.args.includes("push"));

    expect(push).toBeDefined();
    expect(push!.args).toContain(`${HEAD_SHA}:refs/heads/${BRANCH}`);
    expect(settlement.git.some((call) => call.command === "gh" && call.args.includes("create"))).toBe(
      true
    );
  });

  /**
   * The reaper runs at every rebind, and a worktree somebody is being asked about looks exactly
   * like an orphan: the run that made it has ended, and nothing on this machine holds it. The
   * marker is the only thing telling them apart, and it reaches `reapOrphans` through the wiring —
   * so a pass that forgot to hand it over would destroy the work before the push, with both halves
   * of the feature unit-tested and green.
   */
  it("does not reap the held worktree before the push", () => {
    const removedAt = settlement.git.findIndex(
      (call) => call.args.includes("worktree") && call.args.includes("remove")
    );
    const pushedAt = settlement.git.findIndex((call) => call.args.includes("push"));

    expect(pushedAt).toBeGreaterThanOrEqual(0);
    // Removed after the pull request exists, or not at all — never before
    expect(removedAt === -1 || removedAt > pushedAt).toBe(true);
  });

  it("tells the board what came of it", () => {
    // One settlement, not two: a lost report is retried whole rather than compensated for
    expect(board.settlements).toEqual([
      { taskId: TASK_ID, state: "delivered", prUrl: PR_URL },
    ]);
  });

  // Until the pull request exists this worktree is the only copy of the work; afterwards it is not
  it("gives the worktree back once the pull request is open", () => {
    expect(existsSync(join(stateDir, "decisions", `${TASK_KEY}.json`))).toBe(false);
    expect(
      settlement.git.some((call) => call.args.includes("worktree") && call.args.includes("remove"))
    ).toBe(true);
  });
});
