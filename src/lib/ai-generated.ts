import { AsyncLocalStorage } from "node:async_hooks";
import { Schema } from "mongoose";
import type { GeneratedBy } from "@/types";

const STORE = Symbol.for("board-planner.generated-by");
const shared = globalThis as typeof globalThis & { [STORE]?: AsyncLocalStorage<GeneratedBy> };
const store = (shared[STORE] ??= new AsyncLocalStorage<GeneratedBy>());

export const MODEL_NAME_MAX_LENGTH = 200;

export function writtenBy<T>(by: GeneratedBy, work: () => T): T {
  return store.run(by, work);
}

export function currentGeneratedBy(): GeneratedBy | undefined {
  return store.getStore();
}

export function pmAgentMark(model: string | undefined): GeneratedBy {
  return { kind: "ai", feature: "pm_agent", ...(model ? { model: model.slice(0, MODEL_NAME_MAX_LENGTH) } : {}) };
}

export const generatedBySchema = new Schema<GeneratedBy>(
  {
    kind: { type: String, enum: ["ai"], required: true },
    feature: { type: String, enum: ["pm_agent"], required: true },
    model: { type: String, maxlength: MODEL_NAME_MAX_LENGTH },
  },
  { _id: false }
);
