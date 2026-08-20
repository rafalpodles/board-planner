import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "fs";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { dirname } from "path";
import { LocalCommands, WorkerCommand } from "./commands.js";
import { Telemetry } from "./telemetry.js";

// A unix domain socket, not a TCP port: a port is reachable by every process on the machine and by
// anything that can make a browser issue a request to localhost. Filesystem permissions are the
// entire boundary here — 0600 on the socket, and nothing else.
//
// That boundary does not hold against this machine's own coding agent. Worker registration is still
// withAdmin, so the laptop holds an instance-admin token, and the agent runs as this same uid with
// Read: it can reach this socket and pause its own worker. What it cannot do is escalate through it.
// No route returns a credential or a repository binding, and no route starts work. Designed on the
// assumption that the secret is already gone, because it effectively is.

// What the operator's own cockpit may know: the effective policy this worker is running under, and
// nothing that would let a reader reach the server or the checkout. No credential, no repository
// path — see the header comment.
// Work settings are per project now, so there is no single answer for "the model" — reporting one
// would show an operator a value no run is using. The machine's own settings stay at the top; each
// bound project reports what it actually resolved to.
export interface LocalProjectView {
  project: string;
  baseBranch: string;
  model: string;
  reviewModel: string;
  maxDiffLines: number;
  taskTimeoutMs: number;
}

export interface LocalConfigView {
  apiUrl: string;
  workerName: string;
  projectCount: number;
  pollIntervalMs: number;
  projects: LocalProjectView[];
  // The GitHub identity this worker pushes as, and the accounts it could be pointed at instead —
  // so the cockpit shows the account rather than making the operator run `gh auth status` to guess
  // which one a run acted as. No token, here or anywhere else on this socket.
  githubAccount: string;
  githubAccounts: { login: string; active: boolean }[];
}

export interface LocalServerDeps {
  socketPath: string;
  // The same dispatcher the server channels use, so pause/resume/stop get the same effects and the
  // same acknowledgement — but by its local entry point, which does not touch the recency guard.
  // That guard orders instants from the server's clock; feeding it this laptop's would let one
  // local pause swallow a later board-issued stop.
  handlers: LocalCommands;
  telemetry: Pick<Telemetry, "subscribe" | "recent" | "current">;
  paused: () => boolean;
  // A function, not a value: policy arrives from the server over SSE and changes under a running
  // worker, so anything captured at startup goes stale the first time an operator edits it.
  config: () => LocalConfigView;
  log?: (message: string) => void;
}

export interface LocalServer {
  ready: Promise<void>;
  close(): Promise<void>;
}

type Route = (request: IncomingMessage, response: ServerResponse) => void;

// A crash leaves the socket inode behind and bind() then fails with EADDRINUSE, so a restart has to
// clear it. Only a socket is ever removed: anything else at that path is somebody's file.
function removeStale(socketPath: string): void {
  const existing = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!existing) return;
  if (!existing.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket; refusing to remove it`);
  }
  unlinkSync(socketPath);
}

export function startLocalServer(deps: LocalServerDeps): LocalServer {
  const log = deps.log ?? ((message: string) => console.error(message));
  const streams = new Set<ServerResponse>();

  function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  function apply(response: ServerResponse, command: WorkerCommand): void {
    deps.handlers[command]();
    json(response, 200, { paused: deps.paused() });
  }

  function openStream(_request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Without this the head sits in the buffer until the first event, and a client that opened the
    // stream to learn the worker is idle would wait for a response that never comes.
    response.flushHeaders();
    streams.add(response);

    // Everything, quota and outcomes included: this is the operator's only local source for why a
    // run stopped. /status stays progress-only, because the replay ring is what has that shape.
    const unsubscribe = deps.telemetry.subscribe((update) => {
      response.write(`data: ${JSON.stringify(update)}\n\n`);
    });

    // The response, not the request: since Node 16 a bodiless GET's IncomingMessage emits "close"
    // as soon as it is consumed, which would tear the subscription down before the first event.
    response.on("close", () => {
      unsubscribe();
      streams.delete(response);
    });
  }

  const routes: Record<string, Route> = {
    "GET /status": (_request, response) => {
      json(response, 200, {
        paused: deps.paused(),
        current: deps.telemetry.current(),
        recent: deps.telemetry.recent(),
      });
    },
    "GET /config": (_request, response) => json(response, 200, deps.config()),
    "GET /stream": openStream,
    "POST /pause": (_request, response) => apply(response, "pause"),
    "POST /resume": (_request, response) => apply(response, "resume"),
    "POST /stop": (_request, response) => apply(response, "stop"),
  };

  const server = createServer((request, response) => {
    request.resume(); // no route reads a body, and an unread one stalls the connection
    const path = (request.url ?? "").split("?")[0];
    const route = routes[`${request.method ?? ""} ${path}`];
    if (!route) {
      json(response, 404, { error: "not found" });
      return;
    }
    try {
      route(request, response);
    } catch (error) {
      log(`local control request failed: ${String(error)}`);
      if (response.headersSent) response.end();
      else json(response, 500, { error: "internal error" });
    }
  });

  const ready = new Promise<void>((resolve, reject) => {
    try {
      mkdirSync(dirname(deps.socketPath), { recursive: true, mode: 0o700 });
      removeStale(deps.socketPath);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    server.once("error", reject);
    server.listen(deps.socketPath, () => {
      server.off("error", reject);
      server.on("error", (error) => log(`local control socket failed: ${String(error)}`));
      try {
        // listen() creates the socket under the process umask, so narrowing it is a second syscall
        // and there is a window before it. What actually closes that window is the umask: at the
        // 022 launchd runs with, the socket lands at 0755 and connect(2) needs the write bit, so no
        // other uid can reach it. It opens at umask 0002 or looser. The mkdir above is not the
        // mitigation — mkdirSync does not chmod a directory that already exists, and this one
        // normally does, since the operator creates it by hand to place the token file.
        chmodSync(deps.socketPath, 0o600);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve();
    });
  });

  return {
    ready,
    // close() takes the socket off disk itself — the open SSE responses are what would otherwise
    // keep the process alive, since closing a server only stops it accepting new connections
    async close() {
      for (const response of streams) response.end();
      streams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
