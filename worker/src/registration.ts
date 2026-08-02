import { CommandHandlers, isWorkerCommand } from "./commands.js";

export const PROTOCOL_VERSION = 1;

export interface Identity {
  workerId: string;
  credential: string;
}

export interface Store {
  read(): string;
  write(text: string, opts?: { mode?: number }): void;
}

export interface RegistrationInfo {
  name: string;
  host: string;
  platform: string;
  version: string;
}

export interface HeartbeatDeps {
  apiBaseUrl: string;
  apiToken: string;
  registration: RegistrationInfo;
  store: Store;
  // The command channel that survives SSE loss and a restart, so this is the durable one
  handlers: CommandHandlers;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface Heartbeat {
  tick(): Promise<void>;
  stop(): void;
  onAbort(cb: () => void): void;
  ack(command: string): void;
  // Surfaced on every heartbeat, so a project this worker cannot bind to shows the reason in
  // /admin/workers without needing its own endpoint. An empty string clears a previously-reported
  // error once the operator fixes it — bindingError is always sent, never merely omitted.
  reportBindingError(message: string): void;
}

interface StoredIdentity extends Identity {
  heartbeatMs: number;
}

// Only a bootstrap retry, never the steady-state heartbeat interval — that one always comes from
// a real registration response, so it can't drift from the server's staleness window
const REGISTER_RETRY_MS = 30_000;

function parseIdentity(text: string): Identity | null {
  try {
    const parsed = JSON.parse(text) as Partial<Identity> | null;
    if (
      parsed &&
      typeof parsed.workerId === "string" &&
      parsed.workerId &&
      typeof parsed.credential === "string" &&
      parsed.credential
    ) {
      return { workerId: parsed.workerId, credential: parsed.credential };
    }
  } catch {
    // empty, missing, or malformed file — same as never registered
  }
  return null;
}

function parseHeartbeatMs(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as { heartbeatMs?: unknown };
    return typeof parsed.heartbeatMs === "number" && parsed.heartbeatMs > 0 ? parsed.heartbeatMs : null;
  } catch {
    return null;
  }
}

export function loadIdentity(store: Pick<Store, "read">): Identity | null {
  return parseIdentity(store.read());
}

export function startHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((message: string) => console.error(message));
  const abortCallbacks: Array<() => void> = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cached: StoredIdentity | null = null;
  let acked: string | undefined;
  let bindingError = "";

  async function register(): Promise<StoredIdentity | null> {
    try {
      const response = await fetchImpl(`${deps.apiBaseUrl}/api/workers/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.apiToken}`,
          "Content-Type": "application/json",
          "X-CP-Protocol": String(PROTOCOL_VERSION),
        },
        body: JSON.stringify(deps.registration),
      });
      if (!response.ok) {
        log(`worker registration failed: ${response.status}`);
        return null;
      }
      const body = (await response.json()) as {
        workerId?: unknown;
        credential?: unknown;
        heartbeatMs?: unknown;
      };
      if (
        typeof body.workerId !== "string" ||
        typeof body.credential !== "string" ||
        typeof body.heartbeatMs !== "number"
      ) {
        log("worker registration returned a malformed response");
        return null;
      }
      const identity: StoredIdentity = {
        workerId: body.workerId,
        credential: body.credential,
        heartbeatMs: body.heartbeatMs,
      };
      deps.store.write(JSON.stringify(identity), { mode: 0o600 });
      return identity;
    } catch (error) {
      log(`worker registration failed: ${String(error)}`);
      return null;
    }
  }

  async function ensureIdentity(): Promise<StoredIdentity | null> {
    if (cached) return cached;
    const text = deps.store.read();
    const identity = parseIdentity(text);
    if (identity) {
      cached = { ...identity, heartbeatMs: parseHeartbeatMs(text) ?? REGISTER_RETRY_MS };
      return cached;
    }
    cached = await register();
    return cached;
  }

  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const identity = await ensureIdentity();
    if (!identity) {
      scheduleNext(REGISTER_RETRY_MS);
      return;
    }

    try {
      const response = await fetchImpl(`${deps.apiBaseUrl}/api/workers/${identity.workerId}/heartbeat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${identity.credential}`,
          "Content-Type": "application/json",
          "X-Worker-Id": identity.workerId,
          "X-CP-Protocol": String(PROTOCOL_VERSION),
        },
        body: JSON.stringify({
          version: deps.registration.version,
          bindingError,
          ...(acked !== undefined ? { acked } : {}),
        }),
      });

      if (response.status === 403) {
        for (const cb of abortCallbacks) cb();
      } else if (response.status === 401) {
        // The credential no longer authenticates (e.g. the worker was deleted server-side) — drop
        // it so the next tick registers afresh instead of retrying the same dead credential forever
        cached = null;
        deps.store.write("", { mode: 0o600 });
      } else if (response.ok) {
        const body = (await response.json().catch(() => null)) as {
          command?: unknown;
          commandIssuedAt?: unknown;
        } | null;
        if (body && isWorkerCommand(body.command)) {
          deps.handlers[body.command](
            typeof body.commandIssuedAt === "string" ? body.commandIssuedAt : undefined
          );
        }
      }
    } catch (error) {
      log(`heartbeat could not reach the server: ${String(error)}`);
    }

    scheduleNext(identity.heartbeatMs);
  }

  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    onAbort(cb) {
      abortCallbacks.push(cb);
    },
    ack(command) {
      acked = command;
    },
    reportBindingError(message) {
      bindingError = message;
    },
  };
}
