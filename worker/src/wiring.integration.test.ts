import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer, IncomingMessage, request as httpRequest, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { CommandResult, Runner, RunOpts } from "./exec.js";
import { createWorker } from "./wiring.js";

const PROJECT_ID = "6512f0a1b2c3d4e5f6a70001";
const TASK_ID = "6512f0a1b2c3d4e5f6a70002";
const WORKER_ID = "6512f0a1b2c3d4e5f6a70003";
const SERVER_RUN_ID = "run-minted-by-the-board";
const ENROLMENT_TOKEN = "cpe_single_use_enrolment";
const MINTED_CREDENTIAL = "cpw_minted_by_the_board";
const REPO = "/repos/demo";
const REMOTE = "git@github.com:owner/repo.git";
const TOOL_DIR = "/opt/cp-integration-bin";
const BASE_SHA = "cafef00d";

const CLAIMED_AGENT = {
  agentId: "6512f0a1b2c3d4e5f6a70003",
  name: "Default",
  sequence: [
    { key: "implement", kind: "step", name: "Implement", prompt: "do it", capability: "edit" },
    { key: "protected-paths", kind: "gate", name: "Protected files", gateKind: "protected-paths" },
    { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size" },
    { key: "test-presence", kind: "gate", name: "Test written", gateKind: "test-presence" },
    { key: "push", kind: "step", name: "Push", deterministic: true },
    { key: "pull-request", kind: "step", name: "Pull request", deterministic: true },
  ],
};

const SEEDED_COLUMNS = [
  { id: "todo", role: "approved", order: 1, triggersPmReview: false },
  { id: "in_progress", role: "active", order: 2, triggersPmReview: false },
  { id: "needs_human_review", role: "review", order: 3, triggersPmReview: true },
  { id: "done", role: "done", order: 4, triggersPmReview: false },
];

interface RecordedEvent {
  taskId: string;
  runId: string;
  phase: string;
  seq: number;
  applied: boolean;
}

const OBJECT_ID = /^[0-9a-f]{24}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function phaseFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phase = value.trim();
  if (!phase || phase.length > 120 || CONTROL_CHARS.test(phase)) return null;
  return phase;
}

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

function startBoard() {
  const calls: string[] = [];
  const events: RecordedEvent[] = [];
  const heartbeats: Array<Record<string, unknown>> = [];
  const comments: string[] = [];
  const statuses: string[] = [];
  const unauthorized: string[] = [];
  const malformed: string[] = [];
  const streams = new Set<ServerResponse>();

  let registered = false;
  let claimed = false;
  const execution = {
    attempts: 1,
    workerId: "",
    runId: "",
    phase: "",
    phaseSeq: undefined as number | undefined,
  };

  function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  function record(taskId: string, runId: string, seq: number, phase: string): boolean {
    const applied =
      taskId === TASK_ID &&
      execution.workerId === WORKER_ID &&
      execution.runId === runId &&
      (execution.phaseSeq === undefined || execution.phaseSeq < seq);
    if (applied) {
      execution.phase = phase;
      execution.phaseSeq = seq;
    }
    return applied;
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
        registered = true;
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
        request.headers["x-cp-protocol"] !== "1" ||
        (path.startsWith("/api/workers/") && !path.startsWith(`/api/workers/${WORKER_ID}`))
      ) {
        unauthorized.push(`${method} ${path}`);
        json(response, 401, { error: "unauthorized" });
        return;
      }

      if (method === "POST" && path === `/api/workers/${WORKER_ID}/heartbeat`) {
        heartbeats.push(body);
        json(response, 200, {});
        return;
      }

      if (method === "GET" && path === `/api/workers/${WORKER_ID}`) {
        json(response, 200, { assignments: [{ project: PROJECT_ID, remote: REMOTE }] });
        return;
      }

      if (method === "GET" && path === `/api/workers/${WORKER_ID}/stream`) {
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        response.flushHeaders();
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }

      if (method === "POST" && path === `/api/workers/${WORKER_ID}/events`) {
        const { taskId, runId, seq } = body;
        const phase = phaseFrom(body.phase);
        if (
          typeof taskId !== "string" ||
          !OBJECT_ID.test(taskId) ||
          typeof runId !== "string" ||
          !runId.trim() ||
          !Number.isSafeInteger(seq) ||
          (seq as number) <= 0 ||
          !phase
        ) {
          malformed.push(JSON.stringify(body));
          json(response, 400, { error: "malformed event" });
          return;
        }
        const applied = record(taskId, runId, seq as number, phase);
        events.push({ taskId, runId, phase, seq: seq as number, applied });
        json(response, 200, { applied });
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
        execution.workerId = WORKER_ID;
        execution.runId = SERVER_RUN_ID;
        execution.phaseSeq = undefined;
        json(response, 200, {
          _id: TASK_ID,
          project: PROJECT_ID,
          taskNumber: 9,
          title: "Add a thing",
          description: "body",
          checklist: [{ text: "it works" }],
          execution: { attempts: execution.attempts, runId: execution.runId },
          agent: CLAIMED_AGENT,
        });
        return;
      }

      if (path.startsWith(`/api/projects/${PROJECT_ID}/tasks/${TASK_ID}/`)) {
        if (path.endsWith("/release")) {
          execution.workerId = "";
          execution.runId = "";
        }
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
    takeTheTask(): void {
      execution.runId = "";
      execution.phase = "";
      execution.phaseSeq = undefined;
    },
    async close(): Promise<void> {
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    calls,
    events,
    heartbeats,
    comments,
    statuses,
    unauthorized,
    malformed,
    isRegistered: () => registered,
  };
}

interface CockpitStatus {
  paused: boolean;
  current: { phase?: string } | null;
  recent: Array<{ phase?: string }>;
}

function readCockpit(socketPath: string): Promise<CockpitStatus> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path: "/status", method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as CockpitStatus);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

const RESULT_PAYLOAD = {
  status: "completed",
  summary: "did it",
  filesChanged: ["src/a.ts"],
  testsAdded: [],
  blockedReason: "",
};

const TOOL_USE_LINE = `${JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "src/a.ts" } }],
  },
})}\n`;

const OPENING = `${JSON.stringify({ type: "system", subtype: "init" })}\n${TOOL_USE_LINE}`;

const RESULT_LINE = `${JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.42,
  result: JSON.stringify(RESULT_PAYLOAD),
})}\n`;

function pipeFlushes(text: string): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += 17) parts.push(text.slice(index, index + 17));
  return parts;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const AGENT_TALK_LIMIT = 80;

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

interface RunReport {
  board: ReturnType<typeof startBoard>;
  errors: string[];
  sawAbort: boolean;
  agentTalked: number;
  cockpit: CockpitStatus | null;
  cockpitError: string;
  pathRepairs: string[];
}

async function runWorkerAgainstTheBoard(opts: { takeTheTask: boolean }): Promise<RunReport> {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-int-"));
  writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: [REPO] }), { mode: 0o600 });

  const board = startBoard();
  const apiBaseUrl = await board.listen();

  const errors: string[] = [];
  const pathRepairs: string[] = [];
  let sawAbort = false;
  let agentTalked = 0;
  let cockpit: CockpitStatus | null = null;
  let cockpitError = "";

  async function agent(agentOpts: RunOpts): Promise<CommandResult> {
    const written: string[] = [];
    const say = (chunk: string): void => {
      written.push(chunk);
      agentOpts.onStdout?.(chunk);
    };

    for (const part of pipeFlushes(OPENING)) {
      say(part);
      await tick();
    }

    await readCockpit(join(stateDir, "worker.sock")).then(
      (status) => {
        cockpit = status;
      },
      (error: unknown) => {
        cockpitError = String(error);
      }
    );

    if (opts.takeTheTask) board.takeTheTask();

    for (let i = 0; i < AGENT_TALK_LIMIT && !agentOpts.signal?.aborted; i += 1) {
      say(TOOL_USE_LINE);
      agentTalked += 1;
      await delay(2);
    }

    if (agentOpts.signal?.aborted) {
      sawAbort = true;
      return { code: 143, stdout: written.join(""), stderr: "terminated", timedOut: false };
    }

    say(RESULT_LINE);
    return ok(written.join(""));
  }

  const runner: Runner = {
    async run(command, args, runOpts) {
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
      if (command === "claude") return agent(runOpts);
      if (args[0] === "ls-remote") return ok(`${BASE_SHA}\t${args[args.length - 1]}\n`);
      if (args.includes("--verify")) return ok(`${BASE_SHA}\n`);
      if (args.includes("rev-parse")) return ok(REPO);
      if (args.includes("get-url")) return ok(REMOTE);
      return ok();
    },
  };

  let stop = (): void => {};
  const worker = createWorker({
    env: {
      CP_API_URL: apiBaseUrl,
      CP_WORKER_NAME: "integration-worker",
      CP_ENROLMENT_TOKEN: ENROLMENT_TOKEN,
      CP_STATE_DIR: stateDir,
      HOME: stateDir,
    },
    runner,
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
    setPath: (value) => pathRepairs.push(value),
  });
  stop = () => worker.shutdown();

  try {
    await worker.run();
  } finally {
    await board.close();
    rmSync(stateDir, { recursive: true, force: true });
  }

  return { board, errors, sawAbort, agentTalked, cockpit, cockpitError, pathRepairs };
}

describe("a task taken from a live run, over a real HTTP surface", () => {
  let report: RunReport;

  beforeAll(async () => {
    report = await runWorkerAgainstTheBoard({ takeTheTask: true });
  }, 30_000);

  it("registers, reports this machine, binds and claims", () => {
    expect(report.board.isRegistered()).toBe(true);
    expect(report.board.heartbeats).toHaveLength(1);
    expect(report.board.heartbeats[0]).toMatchObject({
      bindingError: "",
      repos: [{ remote: REMOTE, path: REPO }],
      preflight: { ok: true },
    });
    expect(report.pathRepairs.join(":")).toContain(TOOL_DIR);
    expect(report.board.calls).toContain(`POST /api/projects/${PROJECT_ID}/tasks/claim`);
    expect(report.board.events.length).toBeGreaterThan(0);
  });

  it("is refused for the reason the board refuses, not for a malformed or unauthorized request", () => {
    expect(report.board.unauthorized).toEqual([]);
    expect(report.board.malformed).toEqual([]);
    expect(report.board.events.some((event) => event.applied)).toBe(true);
    expect(report.board.events.some((event) => !event.applied)).toBe(true);
  });

  it("addresses every event to the run the board minted, in a strictly rising sequence", () => {
    const seqs = report.board.events.map((event) => event.seq);

    expect([...new Set(report.board.events.map((event) => event.runId))]).toEqual([SERVER_RUN_ID]);
    expect([...new Set(report.board.events.map((event) => event.taskId))]).toEqual([TASK_ID]);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("stops the agent rather than spending the rest of the run on work the board will refuse", () => {
    expect(report.sawAbort).toBe(true);
    expect(report.agentTalked).toBeLessThan(AGENT_TALK_LIMIT);
  });

  it("returns the task to the queue and reports no verdict on it", () => {
    expect(report.board.calls).toContain(
      `POST /api/projects/${PROJECT_ID}/tasks/${TASK_ID}/release`
    );
    expect(report.board.statuses).toEqual([]);
    expect(report.board.comments).toEqual(["Returned to the queue: the run was stopped"]);
  });

  it("says once which run the board no longer has", () => {
    const said = report.errors.filter((message) => message.includes("no longer has run"));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain(SERVER_RUN_ID);
    expect(said[0]).toContain(TASK_ID);
  });

  it("shows the operator's own socket the run that was in flight", () => {
    expect(report.cockpitError).toBe("");
    expect(report.cockpit?.current?.phase).toBe("agent");
    expect(report.cockpit?.recent.map((progress) => progress.phase)).toContain("claiming");
  });
});

describe("the same run when the board leaves the task on it", () => {
  let report: RunReport;

  beforeAll(async () => {
    report = await runWorkerAgainstTheBoard({ takeTheTask: false });
  }, 30_000);

  it("runs to its own verdict and never mentions a lost run", () => {
    expect(report.sawAbort).toBe(false);
    expect(report.agentTalked).toBe(AGENT_TALK_LIMIT);
    expect(report.errors.filter((message) => message.includes("no longer has run"))).toEqual([]);
  });

  it("reaches the gates and moves the task on", () => {
    expect(report.board.events.every((event) => event.applied)).toBe(true);
    expect(report.board.statuses).toEqual(["needs_human_review"]);
    expect(report.board.comments.join("")).toContain("blocked the merge at the **test-presence**");
  });
});
