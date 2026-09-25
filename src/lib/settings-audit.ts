import { projectRepositoryUrl } from "@/lib/repository";
import { DEFAULT_PM_AUTONOMY } from "@/types";
import {
  POLICY_FIELD_LABELS,
  PROJECT_POLICY_DEFAULTS,
  isProjectPolicyField,
} from "@/lib/worker-policy";

type Stored = Record<string, unknown>;

const LABELS: Record<string, string> = {
  name: "Name",
  description: "Description",
  icon: "Icon",
  repositoryUrl: "Repository",
  gitlabHost: "GitLab host",
  codaHost: "Coda host",
  codaDocId: "Coda doc",
  codaTableId: "Coda table",
  "worker.enabled": "Workers",
  "worker.lockedByInstance": "Workers locked by an instance admin",
  "pm.enabled": "PM agent",
  "pm.lockedByInstance": "PM agent locked by an instance admin",
  "pm.model": "PM model",
  "pm.contextNotes": "PM project context",
  "pm.dailyTurnCap": "PM turns per day",
  "pm.dailyTokenCap": "PM tokens per day",
  "pm.autonomy.dailyReview": "PM scheduled review",
  "pm.autonomy.reviewHour": "PM first review at",
  "pm.autonomy.reviewIntervalHours": "PM review every (hours)",
  "pm.autonomy.timezone": "PM timezone",
  "pm.autonomy.handleNeedsHumanReview": 'PM reviews "Needs human review"',
};

const TOKENS: Record<string, string> = {
  githubToken: "GitHub token",
  gitlabToken: "GitLab token",
  codaToken: "Coda token",
};

const PM_FIELDS = [
  "enabled",
  "lockedByInstance",
  "model",
  "contextNotes",
  "dailyTurnCap",
  "dailyTokenCap",
  "autonomy.dailyReview",
  "autonomy.reviewHour",
  "autonomy.reviewIntervalHours",
  "autonomy.timezone",
  "autonomy.handleNeedsHumanReview",
];

const PM_DEFAULTS = {
  enabled: false,
  lockedByInstance: false,
  model: "",
  contextNotes: "",
  dailyTurnCap: 0,
  dailyTokenCap: 0,
  autonomy: DEFAULT_PM_AUTONOMY,
};

const SHOWN_AS: Record<string, (value: unknown) => string> = {
  "pm.dailyTurnCap": (value) => (value ? auditValue(value) : "server default"),
  "pm.dailyTokenCap": (value) => (value ? auditValue(value) : "no ceiling"),
};

const MCP_FIELDS: [string, string][] = [
  ["url", "URL"],
  ["authType", "Authentication"],
  ["enabled", "Enabled"],
  ["allowWrites", "Allow writes"],
  ["toolAllowlist", "Tools allowed"],
];

const MAX_SHOWN = 80;

export function auditValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length > 0 ? value.map(auditValue).join(", ") : "none";
  const text = value === undefined || value === null ? "" : String(value).replace(/\s+/g, " ").trim();
  if (!text) return "none";
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text;
}

function at(doc: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node && typeof node === "object" ? (node as Stored)[key] : undefined),
      doc
    );
}

function blank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function same(a: unknown, b: unknown): boolean {
  return (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);
}

function stored(doc: unknown, key: string): unknown {
  return at(doc, key) ?? at({ pm: PM_DEFAULTS }, key);
}

export function auditChange(
  label: string,
  before: unknown,
  after: unknown,
  show: (value: unknown) => string = auditValue
): string | null {
  if (same(before, after)) return null;
  return `${label}: ${show(before)} → ${show(after)}`;
}

function secretChange(label: string, before: unknown, after: unknown): string | null {
  if (before === after) return null;
  const had = typeof before === "string" && before !== "";
  const has = typeof after === "string" && after !== "";
  if (!has) return had ? `${label} cleared` : null;
  return had ? `${label} replaced` : `${label} set`;
}

function policyChanges(before: Stored, updates: Stored): string[] {
  const overrides = (value: unknown) => new Set(Array.isArray(value) ? (value as string[]) : []);
  const pinnedBefore = overrides(at(before, "worker.policyOverrides"));
  const pinnedAfter =
    "worker.policyOverrides" in updates
      ? overrides(updates["worker.policyOverrides"])
      : pinnedBefore;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const field = key.startsWith("worker.policy.") ? key.slice("worker.policy.".length) : "";
    if (!isProjectPolicyField(field)) continue;

    const resolvedBefore = pinnedBefore.has(field) ? at(before, key) : PROJECT_POLICY_DEFAULTS[field];
    const shown = (v: unknown, pinned: boolean) =>
      pinned ? auditValue(v) : `${auditValue(v)} (default)`;
    const wasText = shown(resolvedBefore, pinnedBefore.has(field));
    const isText = shown(value, pinnedAfter.has(field));
    if (wasText !== isText) lines.push(`${POLICY_FIELD_LABELS[field]}: ${wasText} → ${isText}`);
  }
  return lines;
}

interface McpServer {
  name?: string;
  authToken?: string;
  oauth?: { status?: string };
  [field: string]: unknown;
}

function mcpChanges(before: unknown, after: unknown): string[] {
  const list = (value: unknown) => (Array.isArray(value) ? (value as McpServer[]) : []);
  const was = list(before);
  const is = list(after);
  const lines: string[] = [];

  const names = auditChange(
    "PM MCP servers",
    was.map((s) => s.name),
    is.map((s) => s.name)
  );
  if (names) lines.push(names);

  for (const server of is) {
    const old = was.find((s) => s.name === server.name);
    if (!old) continue;
    const label = `PM MCP server ${server.name}`;
    for (const [field, name] of MCP_FIELDS) {
      const line = auditChange(`${label} · ${name}`, old[field], server[field]);
      if (line) lines.push(line);
    }
    const token = secretChange(`${label} · Token`, old.authToken ?? "", server.authToken ?? "");
    if (token) lines.push(token);
    const oauth = auditChange(`${label} · OAuth`, old.oauth?.status, server.oauth?.status);
    if (oauth) lines.push(oauth);
  }
  return lines;
}

function linkList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as { label?: string; url?: string }[]).map((l) => `${l.label} (${l.url})`);
}

function pmChanges(before: Stored, pm: unknown): string[] {
  const after = { pm };
  const lines = PM_FIELDS.map((field) => {
    const key = `pm.${field}`;
    return auditChange(LABELS[key], stored(before, key), stored(after, key), SHOWN_AS[key]);
  });
  lines.push(
    auditChange("PM links", linkList(at(before, "pm.links")), linkList(at(after, "pm.links")))
  );
  return [
    ...lines.filter((line): line is string => line !== null),
    ...mcpChanges(at(before, "pm.mcpServers"), at(after, "pm.mcpServers")),
  ];
}

function fieldName(project: Stored, id: unknown): string {
  if (!id) return "";
  const fields = Array.isArray(project.customFields)
    ? (project.customFields as { _id: unknown; name: string }[])
    : [];
  return fields.find((f) => String(f._id) === String(id))?.name ?? String(id);
}

export function describeSettingsChanges(before: Stored, updates: Stored): string[] {
  const lines: (string | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (key in TOKENS) {
      lines.push(secretChange(TOKENS[key], before[key], value));
    } else if (key === "repositoryUrl") {
      lines.push(
        auditChange(
          LABELS.repositoryUrl,
          projectRepositoryUrl(before),
          projectRepositoryUrl({ ...before, repositoryUrl: String(value ?? "") })
        )
      );
    } else if (key === "estimateFieldId") {
      lines.push(
        auditChange("Estimate field", fieldName(before, before.estimateFieldId), fieldName(before, value))
      );
    } else if (key === "pm") {
      lines.push(...pmChanges(before, value));
    } else if (!key.startsWith("worker.policy")) {
      lines.push(auditChange(LABELS[key] ?? key, stored(before, key), value, SHOWN_AS[key]));
    }
  }

  return [
    ...lines.filter((line): line is string => line !== null),
    ...policyChanges(before, updates),
  ];
}
