import { AsyncLocalStorage } from "node:async_hooks";
import type { Types } from "mongoose";

type LogContext = { organisation: string };

// Shared across Next's copies of this module, like the organisation wall's marks
const STORE = Symbol.for("board-planner.organisation-log");
const PATCHED = Symbol.for("board-planner.organisation-log.console");
const shared = globalThis as typeof globalThis & { [STORE]?: AsyncLocalStorage<LogContext>; [PATCHED]?: boolean };
const store = (shared[STORE] ??= new AsyncLocalStorage<LogContext>());

export function inOrganisation<T>(organisation: Types.ObjectId, work: () => T): T {
  return store.run({ organisation: organisation.toHexString() }, work);
}

// For lines about the whole instance, written from inside one organisation's request
export function outsideOrganisation<T>(work: () => T): T {
  return store.exit(work);
}

export function loggingOrganisation(): string | undefined {
  return store.getStore()?.organisation;
}

const METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** Every line written while a request or a job of one organisation runs names it. */
export function tagConsoleWithOrganisation(target: Pick<Console, (typeof METHODS)[number]> = console): void {
  if (target === console && shared[PATCHED]) return;
  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      const organisation = loggingOrganisation();
      if (!organisation) return original(...args);
      const tag = `[organisation ${organisation}]`;
      // Into the first string, not before it, or its %s/%d placeholders stop being a format
      return typeof args[0] === "string" ? original(`${tag} ${args[0]}`, ...args.slice(1)) : original(tag, ...args);
    };
  }
  if (target === console) shared[PATCHED] = true;
}
