import { ExecutionResult } from "../types.js";
import { Verdict } from "./agent.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isExecutionResult(value: unknown): value is ExecutionResult {
  return (
    isRecord(value) &&
    (value.status === "completed" || value.status === "blocked") &&
    typeof value.summary === "string" &&
    isStringArray(value.filesChanged) &&
    isStringArray(value.testsAdded) &&
    typeof value.blockedReason === "string"
  );
}

export function isVerdict(value: unknown): value is Verdict {
  return isRecord(value) && typeof value.approved === "boolean" && typeof value.reason === "string";
}
