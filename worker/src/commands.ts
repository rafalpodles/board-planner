import { Loop } from "./loop.js";

export type WorkerCommand = "pause" | "resume" | "stop";
export type CommandHandlers = Record<WorkerCommand, (issuedAt?: string) => void>;
export type LocalCommands = Record<WorkerCommand, () => void>;

export interface CommandChannels {
  remote: CommandHandlers;
  local: LocalCommands;
}

const COMMANDS = new Set<string>(["pause", "resume", "stop"]);

export function isWorkerCommand(value: unknown): value is WorkerCommand {
  return typeof value === "string" && COMMANDS.has(value);
}

// An operator asking the worker to stop is a deliberate act and must not cost the task an attempt.
// A process signal can come from a supervisor restarting in a loop, and a task released with its
// attempt refunded every cycle never accrues one — so it never runs out of retries and never
// reaches a human, which is the whole point of counting them.
export const SHUTDOWN_SIGNAL = Symbol("shutdown");

export interface RunGuard {
  under<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  abort(reason?: unknown): void;
}

export function createRunGuard(): RunGuard {
  let current: AbortController | null = null;

  return {
    async under(work) {
      const controller = new AbortController();
      current = controller;
      try {
        return await work(controller.signal);
      } finally {
        if (current === controller) current = null;
      }
    },

    abort(reason) {
      current?.abort(reason);
    },
  };
}

export interface CommandDeps {
  loop: Pick<Loop, "pause" | "resume" | "paused">;
  runs: Pick<RunGuard, "abort">;
  ack: (command: WorkerCommand) => void;
}

export function createCommandHandlers(deps: CommandDeps): CommandChannels {
  // Both SERVER transports deliver the same standing command, so the issuance instant — not the
  // command name — is what separates a redelivery from an operator asking again. Applying is gated
  // on recency, not equality: a heartbeat computed before a later command was written still carries
  // the old issuance, and must not resurrect what that later command already superseded.
  //
  // Every instant compared here comes from the server's clock. A local command must never enter
  // this guard: it would order the laptop's clock against the server's, and a laptop running ahead
  // would make one local pause silently swallow a later board-issued stop — the emergency brake,
  // dropped, while the run carries on to merge.
  let lastAppliedAt = -Infinity;

  function apply(command: WorkerCommand, issuedAt: string | undefined, effect: () => void): void {
    const instant = issuedAt ? Date.parse(issuedAt) : NaN;
    if (Number.isNaN(instant)) {
      // Undated pause/stop is a safe default to apply; undated resume is not — see commit message.
      if (command === "resume") return;
    } else {
      if (instant <= lastAppliedAt) return;
      lastAppliedAt = instant;
    }

    effect();
    settle(command);
  }

  function settle(command: WorkerCommand): void {
    const settled = command === "resume" ? !deps.loop.paused() : deps.loop.paused();
    if (settled) deps.ack(command);
  }

  const effects: Record<WorkerCommand, () => void> = {
    pause: () => deps.loop.pause(),
    resume: () => deps.loop.resume(),
    stop: () => {
      deps.runs.abort();
      deps.loop.pause();
    },
  };

  // A local command arrives by direct call from an operator at this machine. It is never
  // redelivered and never reordered, so it needs no recency guard — and must not touch one.
  function applyLocal(command: WorkerCommand): void {
    effects[command]();
    settle(command);
  }

  return {
    remote: {
      pause: (issuedAt) => apply("pause", issuedAt, effects.pause),
      resume: (issuedAt) => apply("resume", issuedAt, effects.resume),
      stop: (issuedAt) => apply("stop", issuedAt, effects.stop),
    },
    local: {
      pause: () => applyLocal("pause"),
      resume: () => applyLocal("resume"),
      stop: () => applyLocal("stop"),
    },
  };
}
