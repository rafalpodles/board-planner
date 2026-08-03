import { isRateLimitEvent, isResultEvent, RateLimitEvent, RateLimitStatus, StreamEvent } from "./stream.js";

export type Phase = "claiming" | "worktree" | "agent" | "push" | "pr" | "merge" | `gates:${string}`;

export interface ToolActivity {
  name: string;
  target?: string;
}

export interface Progress {
  phase: Phase;
  // Optional because summarise() builds a Progress from an agent stream event, which has no task in
  // scope; the pipeline's own emits carry it.
  taskKey?: string;
  tool?: ToolActivity;
  turns?: number;
  costUsd?: number;
}

export interface Quota {
  status: RateLimitStatus;
  utilization?: number;
  resetsAt?: number;
  rateLimitType?: string;
}

export type OutcomeKind =
  | "merged"
  | "gateRejected"
  | "blocked"
  | "released"
  | "requeued"
  | "failed";

export interface Outcome {
  outcome: OutcomeKind;
  taskKey: string;
  detail?: string;
}

export type TelemetryUpdate = Progress | Quota | Outcome;

export type TelemetryListener = (update: TelemetryUpdate) => void;

export interface Telemetry {
  subscribe(listener: TelemetryListener): () => void;
  emit(update: TelemetryUpdate): void;
  emitEvent(event: StreamEvent): void;
  recent(): Progress[];
}

const RECENT_LIMIT = 50;

// `pattern` is deliberately absent: a grep pattern is arbitrary agent-authored text, so an agent
// searching for a secret would make that secret the target.
const TARGET_KEYS = ["file_path", "path"] as const;

// Naming a key is not enough — nothing stops an agent putting a file body in `file_path`, and the
// tool_use block is summarised whether or not the call then failed. So the value must also look
// like what it claims to be. This bounds what a target can carry; it does not prove the value is a
// real path, and a short single-line string is not distinguishable from one.
const MAX_TARGET_LENGTH = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Quotes, semicolons, equals and backticks are everywhere in code and in assignments of the form
// `TOKEN=...`, and effectively never in a path a tool is asked to open
const NOT_IN_A_PATH = /["'`;=]/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function pathLike(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TARGET_LENGTH) return undefined;
  if (CONTROL_CHARS.test(trimmed) || NOT_IN_A_PATH.test(trimmed)) return undefined;
  return trimmed;
}

const KNOWN_STATUSES: readonly RateLimitStatus[] = ["allowed", "allowed_warning", "rejected"];

export function isQuota(update: TelemetryUpdate): update is Quota {
  return "status" in update;
}

export function isOutcome(update: TelemetryUpdate): update is Outcome {
  return "outcome" in update;
}

// The only values that ever leave a tool input. Read by name and never spread, so an unlisted key
// cannot reach the summary — and every value that does is bounded and shape-checked, because
// choosing the key alone leaves it free to hold anything the agent wants.
function toolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;

  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return pathLike(value);
  }

  const command = record.command;
  if (typeof command === "string") {
    const token = command.trim().split(/\s+/)[0];
    // `FOO=secret npm run build` is ordinary debugging, not an attack, and its first token is a
    // credential rather than the executable
    if (token && !token.includes("=")) return pathLike(token.split("/").pop() ?? token);
  }

  return undefined;
}

function contentBlocks(event: StreamEvent): unknown[] {
  const message = (event as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function lastToolUse(event: StreamEvent): ToolActivity | undefined {
  const blocks = contentBlocks(event);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (typeof block !== "object" || block === null) continue;
    const { type, name, input } = block as { type?: unknown; name?: unknown; input?: unknown };
    if (type !== "tool_use" || typeof name !== "string" || !TOOL_NAME.test(name)) continue;
    const target = toolTarget(input);
    return target === undefined ? { name } : { name, target };
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toQuota(event: RateLimitEvent): Quota | null {
  const info = event.rate_limit_info;
  if (!info) return null;
  const { status } = info;
  if (!status || !KNOWN_STATUSES.includes(status)) return null;
  return {
    status,
    utilization: numberOrUndefined(info.utilization),
    resetsAt: numberOrUndefined(info.resetsAt),
    rateLimitType: typeof info.rateLimitType === "string" ? info.rateLimitType : undefined,
  };
}

export function summarise(event: StreamEvent): TelemetryUpdate | null {
  if (isRateLimitEvent(event)) return toQuota(event);

  if (isResultEvent(event)) {
    return {
      phase: "agent",
      turns: numberOrUndefined(event.num_turns),
      costUsd: numberOrUndefined(event.total_cost_usd),
    };
  }

  if (event.type === "assistant") {
    const tool = lastToolUse(event);
    return tool ? { phase: "agent", tool } : null;
  }

  return null;
}

export function createTelemetry(): Telemetry {
  const listeners = new Set<TelemetryListener>();
  const ring: Progress[] = [];

  function emit(update: TelemetryUpdate): void {
    if (!isQuota(update) && !isOutcome(update)) {
      ring.push(update);
      if (ring.length > RECENT_LIMIT) ring.shift();
    }
    for (const listener of [...listeners]) {
      try {
        listener(update);
      } catch {
        // emit is called synchronously from pipeline stages; a broken sink must not abort the run
      }
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit,
    emitEvent(event) {
      const update = summarise(event);
      if (update) emit(update);
    },
    recent: () => [...ring],
  };
}

// A phase is not a report: dropping one costs a stale UI for seconds, whereas queueing them behind a
// slow server would outlive the run they describe. reporter.ts has the outbox because a lost report
// strands a task.
export function dropWhenBusy(send: (update: TelemetryUpdate) => Promise<unknown>): TelemetryListener {
  let inFlight = false;
  return (update) => {
    if (inFlight) return;
    inFlight = true;
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(send(update));
    } catch {
      inFlight = false;
      return;
    }
    void pending.catch(() => {}).finally(() => {
      inFlight = false;
    });
  };
}
