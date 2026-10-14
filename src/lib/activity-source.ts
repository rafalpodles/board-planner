import { AsyncLocalStorage } from "node:async_hooks";
import type { ActivitySource, IUser, ShownActivitySource } from "@/types";
import { ACTIVITY_SOURCES } from "@/types";
import { currentGeneratedBy } from "@/lib/ai-generated";

export interface Provenance {
  source: ActivitySource;
  detail?: string;
}

export const SOURCE_DETAIL_MAX_LENGTH = 200;
export const MCP_CLIENT_HEADER = "x-bp-client";
export const MCP_CLIENT_VALUE = "mcp";

const STORE = Symbol.for("board-planner.activity-source");
const shared = globalThis as typeof globalThis & { [STORE]?: AsyncLocalStorage<Provenance> };
const store = (shared[STORE] ??= new AsyncLocalStorage<Provenance>());

export function actingThrough<T>(provenance: Provenance, work: () => T): T {
  const detail = provenance.detail?.trim().slice(0, SOURCE_DETAIL_MAX_LENGTH);
  return store.run({ source: provenance.source, ...(detail ? { detail } : {}) }, work);
}

export function currentProvenance(): Provenance {
  const generatedBy = currentGeneratedBy();
  if (generatedBy?.feature === "pm_agent") {
    return { source: "pm-agent", ...(generatedBy.model ? { detail: generatedBy.model } : {}) };
  }
  return store.getStore() ?? { source: "system" };
}

export function provenanceFields(): { source: ActivitySource; sourceDetail?: string } {
  const { source, detail } = currentProvenance();
  return { source, ...(detail ? { sourceDetail: detail } : {}) };
}

// A browser session is the only credential a person types behind; a header never makes a token one
export function provenanceOfRequest(request: Request, user: IUser): Provenance {
  if (!user.viaMachineCredential) return { source: "web-ui" };
  const throughMcp = request.headers.get(MCP_CLIENT_HEADER) === MCP_CLIENT_VALUE;
  return { source: throughMcp ? "mcp" : "api", detail: user.oauthClientName || undefined };
}

export function shownSource(source: unknown): ShownActivitySource {
  return (ACTIVITY_SOURCES as readonly unknown[]).includes(source) ? (source as ActivitySource) : "legacy";
}

export function withShownSource<T extends { source?: unknown }>(row: T): T & { source: ShownActivitySource } {
  return { ...row, source: shownSource(row.source) };
}
