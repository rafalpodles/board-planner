const DEFAULT_HOST = "https://coda.io";
const REQUEST_TIMEOUT_MS = 15000;
const MUTATION_POLL_ATTEMPTS = 10;
const MUTATION_POLL_INTERVAL_MS = 1000;
// Coda allows 10 writes per 6s; one upsert carries the whole batch, so a chunk
// per request keeps even a large board to a handful of calls
const UPSERT_CHUNK = 200;

export const CODA_COLUMNS = [
  "Key",
  "Title",
  "Status",
  "Assignee",
  "Priority",
  "Difficulty",
  "Category",
  "Due",
  "Link",
] as const;

export const CODA_KEY_COLUMN = "Key";

export interface CodaTaskRow {
  key: string;
  title: string;
  status: string;
  assignee: string;
  priority: string;
  difficulty: string;
  category: string;
  due: string;
  link: string;
}

// The host is validated on write with the same guard GitLab uses; here it is
// only normalised for URL building
export function normaliseCodaHost(host: string): string {
  return (host || "").trim().replace(/\/+$/, "") || DEFAULT_HOST;
}

function apiBase(host: string, docId: string): string {
  return `${host}/apis/v1/docs/${encodeURIComponent(docId)}`;
}

async function codaFetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Coda API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  return res.json();
}

interface CodaColumn {
  id: string;
  name: string;
}

export async function fetchTableColumns(
  host: string,
  docId: string,
  tableId: string,
  token: string
): Promise<string[]> {
  const data = await codaFetch<{ items: CodaColumn[] }>(
    `${apiBase(host, docId)}/tables/${encodeURIComponent(tableId)}/columns?limit=100`,
    token
  );
  return (data.items || []).map((c) => c.name);
}

// Reshaping someone's hand-built doc is the destructive option, so a missing
// column is reported rather than created
export function missingColumns(present: string[]): string[] {
  const have = new Set(present.map((n) => n.trim().toLowerCase()));
  return CODA_COLUMNS.filter((c) => !have.has(c.toLowerCase()));
}

function toCells(row: CodaTaskRow) {
  return [
    { column: "Key", value: row.key },
    { column: "Title", value: row.title },
    { column: "Status", value: row.status },
    { column: "Assignee", value: row.assignee },
    { column: "Priority", value: row.priority },
    { column: "Difficulty", value: row.difficulty },
    { column: "Category", value: row.category },
    { column: "Due", value: row.due },
    { column: "Link", value: row.link },
  ];
}

// Writes return 202 with a requestId — the edit is queued, not applied, so the
// caller must not report success until the mutation reports completed
async function awaitMutation(host: string, token: string, requestId: string): Promise<boolean> {
  for (let attempt = 0; attempt < MUTATION_POLL_ATTEMPTS; attempt++) {
    const status = await codaFetch<{ completed?: boolean }>(
      `${host}/apis/v1/mutationStatus/${encodeURIComponent(requestId)}`,
      token
    );
    if (status.completed) return true;
    await new Promise((resolve) => setTimeout(resolve, MUTATION_POLL_INTERVAL_MS));
  }
  return false;
}

export interface CodaSyncResult {
  pushed: number;
  requests: number;
  allApplied: boolean;
}

export async function upsertTaskRows(
  host: string,
  docId: string,
  tableId: string,
  token: string,
  rows: CodaTaskRow[]
): Promise<CodaSyncResult> {
  const url = `${apiBase(host, docId)}/tables/${encodeURIComponent(tableId)}/rows`;
  let requests = 0;
  let allApplied = true;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const body = {
      rows: chunk.map((row) => ({ cells: toCells(row) })),
      keyColumns: [CODA_KEY_COLUMN],
    };
    const res = await codaFetch<{ requestId?: string }>(url, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
    requests++;
    if (res.requestId && !(await awaitMutation(host, token, res.requestId))) {
      allApplied = false;
    }
  }

  return { pushed: rows.length, requests, allApplied };
}
