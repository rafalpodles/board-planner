"use client";

import { ChangeEvent, useCallback, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { SettingsCard } from "@/components/settings/SettingsCard";
import type { ImportReport } from "@/lib/import/engine";
import { MAX_IMPORT_BYTES } from "@/lib/import/limits";
import { type CsvTable, decodeCsv, readCsvTable } from "@/lib/import/csv";
import { isJiraXml, jiraXmlToTable } from "@/lib/import/jira-xml";
import { isTrelloExport, trelloToTable } from "@/lib/import/trello";
import { readXlsxTable } from "@/lib/import/xlsx";
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
  const [everything, setEverything] = useState(false);
  if (items.length === 0) return null;
  return (
    <details className="text-sm" open={items.length <= 5}>
      <summary className="cursor-pointer font-medium">
        {title} ({items.length})
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-muted">
        {(everything ? items : items.slice(0, LISTED)).map((item, i) => (
          <li key={i} className="break-words">
            {line(item)}
          </li>
        ))}
      </ul>
      {items.length > LISTED && !everything && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => setEverything(true)}>
          Show the other {items.length - LISTED}
        </Button>
      )}
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
        {report.comments.created + report.comments.updated} comments
        {report.links > 0 && `, and ${report.links} new ${report.links === 1 ? "link" : "links"} between tasks`}.
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

const isJson = (file: File) => /\.json$/i.test(file.name) || file.type === "application/json";

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function ImportSection({ projectId, project, patchProject }: Pick<SectionProps, "projectId" | "project" | "patchProject">) {
  const api = useApi();
  // The key travels with the payload, so a check is recorded against exactly what it sent
  const [{ payload, key }, setPayload] = useState<{ payload: Payload | null; key: string }>({ payload: null, key: "" });
  const [table, setTable] = useState<{ rows: CsvTable; fileName: string } | null>(null);
  const sent = useRef("");
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
    const mine = seq.current;
    sent.current = "";
    setPayload({ payload: null, key: "" });
    setTable(null);
    setReport(null);
    setChecked(false);
    setError("");
    setFileError("");
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return setFileError("The file is larger than the 20 MB an import takes.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (mine !== seq.current) return;
    const tabular = async (): Promise<{ table: CsvTable | null; error?: string; name?: string }> => {
      // An .xlsx is a zip: "PK"
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        try {
          return { table: await readXlsxTable(bytes, new DOMParser()) };
        } catch {
          return { table: null, error: "This workbook could not be read. Save it as .xlsx or .csv and try again." };
        }
      }
      const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
      if (!utf16 && bytes.subarray(0, 4096).includes(0)) {
        return { table: null, error: "This is not a text file. Save it as .xlsx or .csv and try again." };
      }
      const text = decodeCsv(bytes);
      if (isJiraXml(text)) {
        const table = jiraXmlToTable(text, new DOMParser());
        return table ? { table, name: "Jira" } : { table: null, error: "This XML file could not be read." };
      }
      if (/<rss[\s>]/.test(text) && /RSS generated by JIRA/i.test(text)) return { table: null, error: "This Jira export holds no issues." };
      if (/^\s*</.test(text) && (/^\s*<(?:!doctype\s+html|html)[\s>]/i.test(text) || /<table[\s>]/i.test(text.slice(0, 20_000)))) {
        return { table: null, error: "This is a web page saved under a spreadsheet's name. Open it in Excel, save it as .xlsx or .csv, and try again." };
      }
      if (/^\s*</.test(text)) return { table: null, error: "Of XML files, only Jira's XML export can be read." };
      if (isJson(file) || /^\s*\{/.test(text)) {
        const json = parsedJson(text);
        if (!isTrelloExport(json)) return { table: null };
        const board = trelloToTable(json);
        return board.rows.length ? { table: board, name: "Trello" } : { table: null, error: "This Trello export holds no open cards." };
      }
      return { table: readCsvTable(text) };
    };
    const read = await tabular();
    if (mine !== seq.current) return;
    if (read.error) return setFileError(read.error);
    if (read.table) {
      if (read.table.headers.length === 0 || read.table.rows.length === 0) return setFileError("This file holds no rows under a header line.");
      return setTable({ rows: read.table, fileName: read.name ?? file.name });
    }
    const text = decodeCsv(bytes);
    try {
      const next = payloadOf(JSON.parse(text));
      if (!next) return setFileError("This file holds no import bundle: it needs a list of tasks.");
      sent.current = `file:${mine}`;
      setPayload({ payload: next, key: sent.current });
    } catch {
      setFileError("This file is not JSON.");
    }
  }

  async function send(dryRun: boolean) {
    if (!payload) return;
    const mine = ++seq.current;
    const asked = key;
    setBusy(dryRun ? "checking" : "importing");
    setChecked(false);
    setError("");
    try {
      const answer: ImportReport = await api.post(`/api/projects/${projectId}/import`, { ...payload, dryRun });
      // The mapping may have moved on while this was answered; then this check is not of what is on screen
      const current = asked === sent.current;
      if (mine !== seq.current || (dryRun && !current)) return;
      setReport(answer);
      setChecked(dryRun && !answer.error && current);
      if (dryRun && current && table && remembered.current) rememberCsvMapping(projectId, table.rows.headers, remembered.current);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : "The import could not run");
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  }

  const csvChanged = useCallback((next: CsvPayload | null, remember: Parameters<typeof rememberCsvMapping>[2], now: string) => {
    remembered.current = remember;
    if (now === sent.current) return;
    sent.current = now;
    setPayload({ payload: next, key: now });
    setChecked(false);
    setReport(null);
  }, []);

  const columnsAdded = useCallback((columns: ApiProjectColumn[]) => patchProject({ columns }), [patchProject]);

  return (
    <SettingsCard title="Import tasks">
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text-muted">Import file (CSV, Excel, Jira XML or JSON)</span>
          <input
            type="file"
            accept="application/json,.json,text/csv,.csv,.tsv,.txt,.xlsx,.xml"
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
            table={table.rows}
            fileName={table.fileName}
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
