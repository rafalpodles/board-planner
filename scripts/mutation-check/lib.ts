import path from "node:path";

export interface Edit {
  find: string;
  replace: string;
}

export interface Mutation {
  id: string;
  file: string;
  edits: Edit[];
  spec: string;
  grep: string;
  probe: string;
  assertion: string;
  control: boolean;
}

export interface JournalEntry {
  file: string;
  original: string;
}

export type Outcome = "caught" | "survived" | "baseline-red" | "not-picked-up" | "no-tests";

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  firstError: string;
}

export interface Result {
  mutation: Mutation;
  outcome: Outcome;
  detail: string;
}

const MARKABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function requireString(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  return value;
}

export function insideRepo(relative: string): boolean {
  if (path.isAbsolute(relative)) return false;
  const normalised = path.posix.normalize(relative.replaceAll("\\", "/"));
  return !normalised.startsWith("../") && normalised !== "..";
}

export function parseManifest(raw: string): Mutation[] {
  const parsed = JSON.parse(raw) as { mutations?: unknown };
  if (!Array.isArray(parsed.mutations) || parsed.mutations.length === 0) {
    throw new Error('the manifest needs a non-empty "mutations" array');
  }
  const seen = new Set<string>();
  return parsed.mutations.map((value, index) => {
    const entry = value as Record<string, unknown>;
    const where = `mutation #${index + 1}`;
    const id = requireString(entry, "id", where);
    const named = `mutation "${id}"`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${named}: an id is lowercase words joined by "-"`);
    if (seen.has(id)) throw new Error(`${named}: the id is used twice`);
    seen.add(id);

    const file = requireString(entry, "file", named);
    if (!insideRepo(file)) throw new Error(`${named}: "${file}" is outside the repository`);
    if (!MARKABLE.test(file)) throw new Error(`${named}: only script sources can carry the pick-up marker`);
    const spec = requireString(entry, "spec", named);
    if (!insideRepo(spec) || !spec.startsWith("e2e/") || !spec.endsWith(".spec.ts")) {
      throw new Error(`${named}: "spec" must be an e2e/*.spec.ts path`);
    }
    const probe = requireString(entry, "probe", named);
    if (!probe.startsWith("/")) throw new Error(`${named}: "probe" is a path on the app, starting with /`);

    if (!Array.isArray(entry.edits) || entry.edits.length === 0) {
      throw new Error(`${named}: "edits" must be a non-empty array of { find, replace }`);
    }
    const edits = entry.edits.map((edit, n) => {
      const e = edit as Record<string, unknown>;
      const find = requireString(e, "find", `${named} edit #${n + 1}`);
      if (typeof e.replace !== "string") throw new Error(`${named} edit #${n + 1}: "replace" must be a string`);
      if (e.replace === find) throw new Error(`${named} edit #${n + 1}: "replace" equals "find"`);
      return { find, replace: e.replace };
    });

    return {
      id,
      file,
      edits,
      spec,
      grep: requireString(entry, "grep", named),
      probe,
      assertion: requireString(entry, "assertion", named),
      control: entry.control === true,
    };
  });
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

export function applyEdits(source: string, edits: Edit[]): string {
  return edits.reduce((text, { find, replace }, n) => {
    const count = occurrences(text, find);
    if (count !== 1) {
      throw new Error(`edit #${n + 1} must match exactly once, matched ${count} times: ${JSON.stringify(find.slice(0, 80))}`);
    }
    return text.replace(find, () => replace);
  }, source);
}

export function marked(source: string, marker: string): string {
  return `// ${marker}\n${source}`;
}

export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface FileSystem {
  read(file: string): string;
  write(file: string, content: string): void;
}

export function restoreAll(journal: JournalEntry[], fs: FileSystem): string[] {
  const restored: string[] = [];
  for (const { file, original } of [...journal].reverse()) {
    if (fs.read(file) !== original) {
      fs.write(file, original);
      restored.push(file);
    }
  }
  return restored;
}

interface ReportNode {
  suites?: ReportNode[];
  specs?: { tests: { results: { status: string; error?: { message?: string; location?: { file: string; line: number } } }[] }[] }[];
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function summarise(report: { suites?: ReportNode[]; errors?: { message?: string }[] }): RunSummary {
  const summary: RunSummary = { passed: 0, failed: 0, skipped: 0, firstError: "" };
  const walk = (node: ReportNode) => {
    node.suites?.forEach(walk);
    for (const spec of node.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results.at(-1);
        if (!last || last.status === "skipped") summary.skipped++;
        else if (last.status === "passed") summary.passed++;
        else {
          summary.failed++;
          if (!summary.firstError) {
            const at = last.error?.location;
            summary.firstError = firstLine(last.error?.message) + (at ? ` (${path.basename(at.file)}:${at.line})` : "");
          }
        }
      }
    }
  };
  report.suites?.forEach(walk);
  if (!summary.firstError && report.errors?.length) summary.firstError = firstLine(report.errors[0].message);
  return summary;
}

function firstLine(message: string | undefined): string {
  return (message ?? "").replace(ANSI, "").trim().split("\n")[0].slice(0, 160);
}

export function classify(summary: RunSummary): Outcome {
  if (summary.failed > 0) return "caught";
  if (summary.passed === 0) return "no-tests";
  return "survived";
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderTable(results: Result[]): string {
  const rows = results.map(({ mutation, outcome, detail }) =>
    `| ${cell(mutation.id)}${mutation.control ? " (control)" : ""} | ${cell(mutation.spec.replace(/^e2e\//, ""))} | ${cell(mutation.assertion)} | **${outcome}** | ${cell(detail)} |`
  );
  return [
    "| id | spec | assertion | result | detail |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
