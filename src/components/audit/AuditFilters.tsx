"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

export interface AuditFilterValues {
  from: string;
  to: string;
  action: string;
  actor: string;
}

export const NO_AUDIT_FILTERS: AuditFilterValues = { from: "", to: "", action: "", actor: "" };

export function auditQuery(filters: AuditFilterValues, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value.trim()) query.set(key, value.trim());
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function AuditFilters({
  actions,
  applied,
  onApply,
  exportUrl,
}: {
  actions: { value: string; label: string }[];
  applied: AuditFilterValues;
  onApply: (filters: AuditFilterValues) => void;
  exportUrl: string;
}) {
  const [draft, setDraft] = useState<AuditFilterValues>(applied);
  const set = (key: keyof AuditFilterValues) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const invalidRange = !!draft.from && !!draft.to && draft.from > draft.to;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!invalidRange) onApply(draft);
  }

  return (
    <form onSubmit={submit} aria-label="Filter the audit log" className="mb-4 space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="From" type="date" value={draft.from} onChange={(e) => set("from")(e.target.value)} />
        <Input
          label="To"
          type="date"
          value={draft.to}
          onChange={(e) => set("to")(e.target.value)}
          error={invalidRange ? "Must not be before From" : undefined}
        />
        <Select
          label="Action"
          placeholder="Any action"
          options={actions}
          value={draft.action}
          onChange={(e) => set("action")(e.target.value)}
        />
        <Input
          label="Actor"
          placeholder="Username"
          value={draft.actor}
          maxLength={100}
          onChange={(e) => set("actor")(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={invalidRange}>
          Apply
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(NO_AUDIT_FILTERS);
            onApply(NO_AUDIT_FILTERS);
          }}
        >
          Clear
        </Button>
        <span className="ml-auto flex flex-wrap items-center gap-2 text-sm text-text-muted">
          Export
          <a
            className="focus-ring rounded-lg border border-border bg-bg-input px-3 py-1.5 text-text hover:bg-bg-hover"
            href={`${exportUrl}${auditQuery(applied, { format: "csv" })}`}
            download
          >
            CSV
          </a>
          <a
            className="focus-ring rounded-lg border border-border bg-bg-input px-3 py-1.5 text-text hover:bg-bg-hover"
            href={`${exportUrl}${auditQuery(applied, { format: "ndjson" })}`}
            download
          >
            NDJSON
          </a>
        </span>
      </div>
    </form>
  );
}
