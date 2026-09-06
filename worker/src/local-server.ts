import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "fs";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { dirname } from "path";
import { LocalCommands, WorkerCommand } from "./commands.js";
import { Telemetry } from "./telemetry.js";

export interface LocalProjectView {
  project: string;
  blocked: string;
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
  githubAccount: string;
  githubAccounts: { login: string; active: boolean }[];
  offers: { project: string; key: string; name: string; repositoryUrl: string }[];
  catalogue: {
    project: string;
    key: string;
    name: string;
    repositoryUrl: string;
    available: boolean;
    workersEnabled: boolean;
    servedHere: boolean;
    wanted: boolean;
  }[];
}

export interface LocalServerDeps {
  socketPath: string;
  handlers: LocalCommands;
  telemetry: Pick<Telemetry, "subscribe" | "recent" | "current">;
  paused: () => boolean;
  config: () => LocalConfigView;
  log?: (message: string) => void;
}

export interface LocalServer {
  ready: Promise<void>;
  close(): Promise<void>;
}

type Route = (request: IncomingMessage, response: ServerResponse) => void;

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
    response.flushHeaders();
    streams.add(response);

    const unsubscribe = deps.telemetry.subscribe((update) => {
      response.write(`data: ${JSON.stringify(update)}\n\n`);
    });

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
