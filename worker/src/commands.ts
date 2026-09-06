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
  let lastAppliedAt = -Infinity;

  function apply(command: WorkerCommand, issuedAt: string | undefined, effect: () => void): void {
    const instant = issuedAt ? Date.parse(issuedAt) : NaN;
    if (Number.isNaN(instant)) {
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
