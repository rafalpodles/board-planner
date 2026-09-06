"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiAgent, ApiAgentBlock } from "@/types";
import { BUCKETS, CAPABILITIES, gateKindByKey } from "../catalog";

function DefaultBadge() {
  return (
    <span className="shrink-0 rounded bg-bg-input px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
      default
    </span>
  );
}

export function blockSummary(block: ApiAgentBlock): string {
  if (block.kind === "step") {
    if (block.deterministic) return "no model";
    const capability = CAPABILITIES.find((c) => c.value === block.capability)?.label ?? "";
    return [capability.toLowerCase(), block.model].filter(Boolean).join(" · ");
  }

  const kind = block.gateKind ? gateKindByKey(block.gateKind) : undefined;
  if (!kind) return "";

  return kind.params
    .map((param) => {
      const value = block.params?.[param.key];
      if (!value) return null;
      const label =
        param.type === "select" ? param.options?.find((o) => o.value === value)?.label : value;
      return `${param.label.toLowerCase()} ${label}`;
    })
    .filter(Boolean)
    .join(" · ");
}

function DeleteButton({ label, onDelete }: { label: string; onDelete: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <>
      <button
        disabled={busy}
        aria-label={`Delete ${label}`}
        onClick={async (e) => {
          e.preventDefault();
          setError("");
          setBusy(true);
          try {
            await onDelete();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not delete");
          } finally {
            setBusy(false);
          }
        }}
        className="focus-ring shrink-0 rounded p-1 text-text-muted transition-colors hover:text-danger disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
          <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" />
        </svg>
      </button>
      {error && <p className="mt-1 w-full text-[12px] text-danger">{error}</p>}
    </>
  );
}

export function BlockList({
  rows,
  onDelete,
  onEdit,
}: {
  rows: ApiAgentBlock[];
  onDelete: (blockId: string) => Promise<void>;
  onEdit: (block: ApiAgentBlock) => void;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-card">
      {rows.map((row) => {
        const summary = blockSummary(row);
        return (
          <li key={row.key} className="px-3.5 py-3 transition-colors hover:bg-bg-hover">
            <div className="flex flex-wrap items-baseline gap-2">
              <button
                onClick={() => onEdit(row)}
                className="focus-ring rounded text-left text-[14px] font-medium hover:underline"
              >
                {row.name}
              </button>
              {row.builtIn && <DefaultBadge />}
              {summary && (
                <span className="ml-auto shrink-0 text-[11px] text-text-muted">{summary}</span>
              )}
              {!row.builtIn && (
                <DeleteButton label={row.name} onDelete={() => onDelete(row._id)} />
              )}
            </div>
            <p className="mt-0.5 text-[13px] text-text-muted">{row.description}</p>
          </li>
        );
      })}
    </ul>
  );
}

function countOf(agent: ApiAgent): string {
  const count = BUCKETS.reduce((n, b) => n + (agent.composition[b.id]?.length ?? 0), 0);
  return count === 0 ? "Nothing in it yet" : `${count} in sequence`;
}

export function AgentList({
  rows,
  empty,
  onDelete,
}: {
  rows: ApiAgent[];
  empty: string;
  onDelete?: (agentId: string) => Promise<void>;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3.5 py-6 text-center text-[13px] text-text-muted">
        {empty}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-card">
      {rows.map((agent) => (
        <li key={agent._id}>
          <Link
            href={`/agents/${agent._id}`}
            className="focus-ring block px-3.5 py-3 transition-colors hover:bg-bg-hover"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium">{agent.name}</span>
              {agent.projectName && (
                <span className="text-[11px] text-text-muted">{agent.projectName}</span>
              )}
              <span className="ml-auto shrink-0 text-[11px] text-text-muted">{countOf(agent)}</span>
              {onDelete && !agent.builtIn && (
                <DeleteButton label={agent.name} onDelete={() => onDelete(agent._id)} />
              )}
            </div>
            <p className="mt-0.5 text-[13px] text-text-muted">
              {agent.description || "No description yet."}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">{title}</h2>
      <p className="mb-2.5 mt-1 text-[13px] text-text-muted">{hint}</p>
      {children}
    </section>
  );
}
