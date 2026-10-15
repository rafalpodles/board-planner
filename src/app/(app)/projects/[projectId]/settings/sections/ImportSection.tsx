"use client";

import { ChangeEvent, useCallback, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { SettingsCard } from "@/components/settings/SettingsCard";
import type { ImportReport } from "@/lib/import/engine";
import { MAX_IMPORT_BYTES } from "@/lib/import/limits";
import { type CsvTable, decodeCsv, readCsvTable } from "@/lib/import/csv";
import type { ApiProjectColumn } from "@/types";
import { CsvMapping, type CsvPayload, rememberCsvMapping } from "./CsvMapping";
import type { SectionProps } from "./types";

// The request wraps the file in a little JSON of its own
const MAX_FILE_BYTES = MAX_IMPORT_BYTES - 64 * 1024;
const LISTED = 50;

type Payload = { bundle: unknown; mapping?: unknown };

function payloadOf(parsed: unknown): Payload | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const object = parsed as Record<string, unknown>;
  if ("bundle" in object) return { bundle: object.bundle, mapping: object.mapping };
  return "tasks" in object ? { bundle: object } : null;
}

function Listed<T>({ title, items, line }: { title: string; items: T[]; line: (item: T) => string }) {
  if (items.length === 0) return null;
  return (
    <details className="text-sm" open={items.length <= 5}>
      <summary className="cursor-pointer font-medium">
        {title} ({items.length})
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-muted">
        {items.slice(0, LISTED).map((item, i) => (
          <li key={i} className="break-words">
            {line(item)}
          </li>
        ))}
        {items.length > LISTED && <li>and {items.length - LISTED} more</li>}
      </ul>
    </details>
  );
}

function Report({ report }: { report: ImportReport }) {
  const verb = report.dryRun ? "Would create" : "Created";
  return (
    <div data-testid="import-report" className="space-y-3">
      {report.error && (
        <p role="alert" className="text-sm text-danger">
          The import stopped after {report.processed} tasks: {report.error}. What was written before that stays; running the same file again picks up where it left off.
        </p>
      )}
      <p className="text-sm">
        {verb} <strong>{report.created}</strong> and {report.dryRun ? "would update" : "updated"}{" "}
        <strong>{report.updated}</strong> of {report.total} tasks from {report.source}, with{" "}
        {report.comments.created + report.comments.updated} comments.
      </p>
      <Listed title="Skipped" items={report.skipped} line={(s) => `${s.id}: ${s.reason}`} />
      <Listed title="Values left out" items={report.dropped} line={(d) => `${d.id} · ${d.field} “${d.value}”: ${d.reason}`} />
      <Listed title="Shortened to fit" items={report.truncated} line={(t) => `${t.id} · ${t.field}`} />
      <Listed title="Statuses with no column (placed where new tasks go)" items={report.unmapped.statuses} line={(s) => s} />
      <Listed title="People with no account here (left unassigned)" items={report.unmapped.users} line={(s) => s} />
      <Listed title="Types with no category (given the default)" items={report.unmapped.types} line={(s) => s} />
      <Listed title="Not imported" items={report.notImported} line={(n) => `${n.id}: ${n.what}`} />
    </div>
  );
}

const isCsv = (file: File) => /\.(csv|tsv|txt)$/i.test(file.name) || /csv|tab-separated/.test(file.type);

export function ImportSection({ projectId, project, patchProject }: Pick<SectionProps, "projectId" | "project" | "patchProject">) {
  const api = useApi();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const remembered = useRef<Parameters<typeof rememberCsvMapping>[2] | null>(null);
  const [fileError, setFileError] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<"checking" | "importing" | null>(null);
  const seq = useRef(0);
  const [error, setError] = useState("");

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    seq.current += 1;
    const file = event.target.files?.[0];
    setPayload(null);
    setTable(null);
    setReport(null);
    setChecked(false);
    setError("");
    setFileError("");
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return setFileError("The file is larger than the 20 MB an import takes.");
    if (isCsv(file)) {
      const read = readCsvTable(decodeCsv(new Uint8Array(await file.arrayBuffer())));
      if (read.headers.length === 0 || read.rows.length === 0) return setFileError("This file holds no rows under a header line.");
      return setTable(read);
    }
    try {
      const next = payloadOf(JSON.parse(await file.text()));
      if (!next) return setFileError("This file holds no import bundle: it needs a list of tasks.");
      setPayload(next);
    } catch {
      setFileError("This file is not JSON.");
    }
  }

  async function send(dryRun: boolean) {
    if (!payload) return;
    const mine = ++seq.current;
    setBusy(dryRun ? "checking" : "importing");
    setChecked(false);
    setError("");
    try {
      const answer: ImportReport = await api.post(`/api/projects/${projectId}/import`, { ...payload, dryRun });
      if (mine !== seq.current) return;
      setReport(answer);
      setChecked(dryRun && !answer.error);
      if (dryRun && table && remembered.current) rememberCsvMapping(projectId, table.headers, remembered.current);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : "The import could not run");
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  }

  const csvChanged = useCallback((next: CsvPayload | null, remember: Parameters<typeof rememberCsvMapping>[2]) => {
    seq.current += 1;
    remembered.current = remember;
    setPayload(next);
    setChecked(false);
    setReport(null);
    setBusy(null);
  }, []);

  const columnsAdded = useCallback((columns: ApiProjectColumn[]) => patchProject({ columns }), [patchProject]);

  return (
    <SettingsCard title="Import tasks">
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text-muted">Import file (CSV or JSON)</span>
          <input
            type="file"
            accept="application/json,.json,text/csv,.csv,.tsv,.txt"
            onChange={choose}
            disabled={busy !== null}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-bg-input file:px-3 file:py-1.5 file:text-text"
          />
        </label>
        {fileError && <p className="text-sm text-danger">{fileError}</p>}
        {table && (
          <CsvMapping
            projectId={projectId}
            project={project}
            table={table}
            disabled={busy !== null}
            onColumns={columnsAdded}
            onChange={csvChanged}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={!payload || busy !== null} onClick={() => send(true)}>
            {busy === "checking" ? "Checking…" : "Check"}
          </Button>
          <Button size="sm" disabled={!checked || busy !== null} onClick={() => send(false)}>
            {busy === "importing" ? "Importing…" : "Import"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {report && <Report report={report} />}
      </div>
    </SettingsCard>
  );
}
