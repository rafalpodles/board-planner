import { echo } from "@/lib/echo";
import { effectiveColumns, type AnyColumn } from "@/lib/columns";
import { normalizeOptions } from "@/lib/custom-fields";
import { AGENT_BUCKETS, type AgentBucket, type AgentComposition, type ApiAgentBlock, type ApiCustomField, type ColumnRole, type StoredComposition } from "@/types";
import { findColumn } from "./board-config";

export type CompositionInput = Partial<Record<AgentBucket, (string | { block: string; params?: Record<string, string> })[]>>;

export interface AgentRow {
  _id: string;
  name: string;
  scope: string;
  projectId: string | null;
  projectName?: string | null;
  builtIn?: boolean;
  composition?: StoredComposition;
}

export function findBlock(ref: string, blocks: ApiAgentBlock[]): ApiAgentBlock {
  const wanted = ref.trim().toLowerCase();
  const byKey = blocks.find((b) => b.key.toLowerCase() === wanted);
  if (byKey) return byKey;
  const named = blocks.filter((b) => b.name.trim().toLowerCase() === wanted);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new Error(`${named.length} blocks are named "${echo(ref.trim())}" — pass the key of one: ${named.map((b) => b.key).join(", ")}`);
  }
  throw new Error(
    `No step or gate "${echo(ref.trim())}", by key or name. list_agent_blocks lists them.`
  );
}

export function compositionFrom(input: CompositionInput, blocks: ApiAgentBlock[]): AgentComposition {
  const composition = {} as AgentComposition;
  for (const bucket of AGENT_BUCKETS) {
    composition[bucket] = (input[bucket] ?? []).map((entry) => {
      const ref = typeof entry === "string" ? entry : entry.block;
      const block = findBlock(ref, blocks);
      const params = typeof entry === "string" ? undefined : entry.params;
      return params && Object.keys(params).length > 0 ? { key: block.key, params } : { key: block.key };
    });
  }
  return composition;
}

/** An agent named the way update_task names one: any case, a project agent only on its own board. */
export function findAgent(name: string, agents: AgentRow[], projectId?: string): AgentRow {
  const wanted = name.trim().toLowerCase();
  const named = agents.filter((a) => a.name.trim().toLowerCase() === wanted);
  const candidates = projectId ? named.filter((a) => a.scope !== "project" || a.projectId === projectId) : named;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const where = candidates.map((a) => (a.scope === "project" ? `project ${a.projectName ?? a.projectId}` : a.scope)).join(", ");
    throw new Error(`${candidates.length} agents are named "${echo(name.trim())}" (${where}) — name the project to pick one.`);
  }
  throw new Error(
    named.length > 0
      ? `Agent "${echo(name.trim())}" belongs to another project.`
      : `Agent "${echo(name.trim())}" not found. list_agents lists them.`
  );
}

export function columnsUpdated(
  stored: AnyColumn[] | null | undefined,
  ref: string,
  change: { role?: ColumnRole; color?: string; triggersPmReview?: boolean }
): AnyColumn[] {
  const target = findColumn(ref, stored);
  return effectiveColumns(stored).map((c) => (c.id === target.id ? { ...c, ...change } : c));
}

export function columnsWithout(stored: AnyColumn[] | null | undefined, ref: string): AnyColumn[] {
  const target = findColumn(ref, stored);
  return effectiveColumns(stored)
    .filter((c) => c.id !== target.id)
    .map((c, order) => ({ ...c, order }));
}

export function columnsInOrder(stored: AnyColumn[] | null | undefined, refs: string[]): AnyColumn[] {
  const columns = effectiveColumns(stored);
  const ordered = refs.map((ref) => findColumn(ref, stored));
  const ids = new Set(ordered.map((c) => c.id));
  if (ids.size !== ordered.length) throw new Error("A column is named twice. Name each column once.");
  const missing = columns.filter((c) => !ids.has(c.id));
  if (missing.length > 0) {
    throw new Error(`Name every column, in the new order. Missing: ${missing.map((c) => `${c.label} (${c.id})`).join(", ")}`);
  }
  return ordered.map((c, order) => ({ ...c, order }));
}

type Option = { id: string; value: string; color: string; order?: number };

export function findOption(ref: string, field: ApiCustomField): Option {
  const options = normalizeOptions(field.options as never) as Option[];
  const wanted = ref.trim().toLowerCase();
  const found = options.find((o) => o.id.toLowerCase() === wanted) ?? options.find((o) => o.value.trim().toLowerCase() === wanted);
  if (!found) {
    throw new Error(
      `No option "${echo(ref.trim())}" on ${echo(field.name)}. Options: ${options.map((o) => o.value).join(", ") || "none"}`
    );
  }
  return found;
}

function orderedOptions(field: ApiCustomField): Option[] {
  return (normalizeOptions(field.options as never) as Option[]).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function optionsUpdated(field: ApiCustomField, ref: string, change: { value?: string; color?: string }): Option[] {
  const target = findOption(ref, field);
  return orderedOptions(field).map((o) =>
    o.id === target.id ? { id: o.id, value: change.value?.trim() || o.value, color: change.color ?? o.color } : { id: o.id, value: o.value, color: o.color }
  );
}

export function optionsWithout(field: ApiCustomField, ref: string): Option[] {
  const target = findOption(ref, field);
  return orderedOptions(field)
    .filter((o) => o.id !== target.id)
    .map((o) => ({ id: o.id, value: o.value, color: o.color }));
}
