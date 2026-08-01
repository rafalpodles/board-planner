import { loadIdentity, PROTOCOL_VERSION, Store } from "./registration.js";

export type WorkerCommand = "pause" | "resume" | "stop";

export interface ControlDeps {
  apiBaseUrl: string;
  identitySource: Pick<Store, "read">;
  handlers: Record<WorkerCommand, () => void>;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
  log?: (message: string) => void;
}

export interface Control {
  close(): void;
}

const COMMANDS = new Set<WorkerCommand>(["pause", "resume", "stop"]);
const MAX_RECONNECT_DELAY_MS = 60_000;

function isWorkerCommand(value: unknown): value is WorkerCommand {
  return typeof value === "string" && COMMANDS.has(value as WorkerCommand);
}

async function consumeFrames(
  body: ReadableStream<Uint8Array>,
  onCommand: (command: WorkerCommand) => void,
  onData: () => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      onData();
      buffer += decoder.decode(value, { stream: true });

      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice("event:".length).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
        }

        if (event === "command" && dataLines.length > 0) {
          try {
            const payload = JSON.parse(dataLines.join("\n")) as { command?: unknown };
            if (isWorkerCommand(payload.command)) onCommand(payload.command);
          } catch {
            // Malformed frame — dropped, not fatal. The next heartbeat still carries the
            // current command, so a frame lost here is not a command lost.
          }
        }

        frameEnd = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// This registers against whichever server process the worker's TCP connection happens to land
// on. On more than one Railway replica, a command published while this stream is open on a
// different replica never arrives here — the heartbeat carries the same command as a fallback,
// so a stream that never connects, or drops and is mid-backoff, degrades to polling rather than
// losing the command.
export function connectControl(deps: ControlDeps): Control {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((message: string) => console.error(message));
  const baseDelay = deps.reconnectDelayMs ?? 2_000;

  let closed = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

  function scheduleReconnect(): void {
    if (closed) return;
    const delay = Math.min(baseDelay * 2 ** retries, MAX_RECONNECT_DELAY_MS);
    retries += 1;
    timer = setTimeout(() => void connect(), delay);
    timer.unref();
  }

  async function connect(): Promise<void> {
    if (closed) return;
    const identity = loadIdentity(deps.identitySource);
    if (!identity) {
      scheduleReconnect();
      return;
    }

    abortController = new AbortController();
    try {
      const response = await fetchImpl(`${deps.apiBaseUrl}/api/workers/${identity.workerId}/stream`, {
        headers: {
          Authorization: `Bearer ${identity.credential}`,
          "X-Worker-Id": identity.workerId,
          "X-CP-Protocol": String(PROTOCOL_VERSION),
        },
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        scheduleReconnect();
        return;
      }
      // A response with a body that never delivers a byte (immediate EOF) must not reset the
      // backoff — only a stream that actually carried data proves the connection was live.
      await consumeFrames(
        response.body,
        (command) => deps.handlers[command](),
        () => { retries = 0; }
      );
    } catch (error) {
      if (!closed) log(`worker control stream failed: ${String(error)}`);
    }
    if (!closed) scheduleReconnect();
  }

  void connect();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      abortController?.abort();
    },
  };
}
