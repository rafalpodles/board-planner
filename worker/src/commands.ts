import { Loop } from "./loop.js";

export type WorkerCommand = "pause" | "resume" | "stop";
export type CommandHandlers = Record<WorkerCommand, (issuedAt?: string) => void>;

const COMMANDS = new Set<string>(["pause", "resume", "stop"]);

export function isWorkerCommand(value: unknown): value is WorkerCommand {
  return typeof value === "string" && COMMANDS.has(value);
}

export interface RunGuard {
  under<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  abort(): void;
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

    abort() {
      current?.abort();
    },
  };
}

export interface CommandDeps {
  loop: Pick<Loop, "pause" | "resume" | "paused">;
  runs: Pick<RunGuard, "abort">;
  ack: (command: WorkerCommand) => void;
}

export function createCommandHandlers(deps: CommandDeps): CommandHandlers {
  // Both transports deliver the same standing command, so the issuance instant — not the command
  // name — is what separates a redelivery from an operator asking again. Applying is gated on
  // recency, not equality: a heartbeat computed before a later command was written still carries
  // the old issuance, and must not resurrect what that later command already superseded.
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

    const settled = command === "resume" ? !deps.loop.paused() : deps.loop.paused();
    if (settled) deps.ack(command);
  }

  return {
    pause: (issuedAt) => apply("pause", issuedAt, () => deps.loop.pause()),
    resume: (issuedAt) => apply("resume", issuedAt, () => deps.loop.resume()),
    stop: (issuedAt) =>
      apply("stop", issuedAt, () => {
        deps.runs.abort();
        deps.loop.pause();
      }),
  };
}
