import { hostOf, projectRepositoryUrl } from "@/lib/repository";
import { maskSecretUrl } from "@/lib/project-secrets";
import { DEFAULT_PM_AUTONOMY } from "@/types";
import {
  POLICY_FIELD_LABELS,
  PROJECT_POLICY_DEFAULTS,
  type ProjectPolicyField,
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

const URLS = new Set(["gitlabHost", "codaHost"]);

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

const MAX_SHOWN = 80;

export function auditValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length > 0 ? value.map(auditValue).join(", ") : "none";
  const text =
    typeof value === "string" || typeof value === "number"
      ? String(value).replace(/\s+/g, " ").replace(/→/g, "->").trim()
      : "";
  if (!text) return "none";
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text;
}

// Whatever a pasted address carries besides where it points — a clone URL's credentials, a token
// in its query — stays out of a trail nobody can edit afterwards. What does not parse as one is
// shown by its host, or not at all: a token pasted into the field would otherwise print whole.
export function auditUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "none";
  const text = value.trim();
  let url: URL | null = null;
  try {
    url = new URL(text);
  } catch {}
  if (url?.host) {
    const credentials = url.username || url.password ? "•••@" : "";
    const query = url.search ? "?•••" : "";
    return auditValue(`${url.protocol}//${credentials}${url.host}${url.pathname}${query}`);
  }
  const ssh = /^[\w.-]+@([\w.-]+):([\w./~-]+)$/.exec(text);
  if (ssh) return auditValue(`${ssh[1]}:${ssh[2]}`);
  const host = hostOf(text);
  return host ? auditValue(host) : "(not a web address)";
}

// An MCP server's or a link's address can be the credential itself, the way a webhook's is
const capabilityUrl = (value: unknown) =>
  typeof value === "string" && value.trim() ? auditValue(maskSecretUrl(value.trim())) : "none";

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
  const was = show(before);
  const is = show(after);
  // Shortened to the same text, an arrow between them would read as no change at all
  return was === is ? `${label} changed` : `${label}: ${was} → ${is}`;
}

function secretChange(label: string, before: unknown, after: unknown): string | null {
  if (before === after) return null;
  const had = typeof before === "string" && before !== "";
  const has = typeof after === "string" && after !== "";
  if (!has) return had ? `${label} cleared` : null;
  return had ? `${label} replaced` : `${label} set`;
}

const SHOWN_AS: Record<string, (value: unknown) => string> = {
  "pm.dailyTurnCap": (value) => (value ? auditValue(value) : "server default"),
  "pm.dailyTokenCap": (value) => (value ? auditValue(value) : "no ceiling"),
};

function policyChanges(before: Stored, after: Stored): string[] {
  const pinned = (doc: Stored) =>
    new Set(((at(doc, "worker.policyOverrides") as string[] | undefined) ?? []).map(String));
  const pinnedBefore = pinned(before);
  const pinnedAfter = pinned(after);

  const lines: string[] = [];
  // Every field rather than the ones a request named: an overrides list another save computed can
  // drop a pin, and that changes what a worker runs just the same
  for (const field of Object.keys(PROJECT_POLICY_DEFAULTS) as ProjectPolicyField[]) {
    const resolved = (doc: Stored, pins: Set<string>) =>
      pins.has(field)
        ? auditValue(at(doc, `worker.policy.${field}`))
        : `${auditValue(PROJECT_POLICY_DEFAULTS[field])} (default)`;
    const was = resolved(before, pinnedBefore);
    const is = resolved(after, pinnedAfter);
    if (was !== is) lines.push(`${POLICY_FIELD_LABELS[field]}: ${was} → ${is}`);
  }
  return lines;
}

interface McpServer {
  name?: string;
  url?: string;
  authType?: string;
  authToken?: string;
  allowWrites?: boolean;
  toolAllowlist?: string[];
  enabled?: boolean;
  oauth?: { status?: string; clientId?: string; clientSecret?: string };
}

// Replacing the list gives every server a fresh _id, stored as well, so an id is no change
function withoutIds(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, (key, v) => (key === "_id" ? undefined : v)));
}

function mcpChanges(before: unknown, after: unknown): string[] {
  const list = (value: unknown) => (Array.isArray(value) ? (value as McpServer[]) : []);
  const was = list(before);
  const is = list(after);
  const lines: string[] = [];

  for (const server of was) {
    if (!is.some((s) => s.name === server.name)) lines.push(`PM MCP server ${server.name} removed`);
  }
  for (const server of is) {
    const label = `PM MCP server ${server.name}`;
    const old = was.find((s) => s.name === server.name);
    if (!old) {
      lines.push(
        `${label} added: ${capabilityUrl(server.url)}, ${auditValue(server.authType)}, writes ${auditValue(
          !!server.allowWrites
        )}`
      );
      continue;
    }
    const found = [
      auditChange(`${label} · URL`, old.url, server.url, capabilityUrl),
      auditChange(`${label} · Authentication`, old.authType, server.authType),
      auditChange(`${label} · Enabled`, old.enabled, server.enabled),
      auditChange(`${label} · Allow writes`, old.allowWrites, server.allowWrites),
      auditChange(`${label} · Tools allowed`, old.toolAllowlist, server.toolAllowlist),
      secretChange(`${label} · Token`, old.authToken ?? "", server.authToken ?? ""),
      auditChange(`${label} · OAuth`, old.oauth?.status, server.oauth?.status),
      auditChange(`${label} · OAuth client`, old.oauth?.clientId, server.oauth?.clientId),
      secretChange(
        `${label} · OAuth client secret`,
        old.oauth?.clientSecret ?? "",
        server.oauth?.clientSecret ?? ""
      ),
    ].filter((line): line is string => line !== null);
    if (found.length === 0 && !same(withoutIds(old), withoutIds(server))) found.push(`${label} changed`);
    lines.push(...found);
  }
  return lines;
}

function linkList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as { label?: string; url?: string }[]).map(
    (l) => `${auditValue(l.label)} (${capabilityUrl(l.url)})`
  );
}

function pmChanges(before: Stored, after: Stored): string[] {
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

/**
 * `before` is the write's own before-image, `after` that image with the write applied the way the
 * schema stores it — so a value the schema drops or trims is not reported as the request sent it.
 */
export function describeSettingsChanges(
  beforeImage: object,
  afterImage: object,
  keys: string[]
): string[] {
  const before = beforeImage as Stored;
  const after = afterImage as Stored;
  const lines: (string | null)[] = [];
  let pm = false;
  let policy = false;

  for (const key of keys) {
    if (key in TOKENS) {
      lines.push(secretChange(TOKENS[key], before[key], after[key]));
    } else if (key === "repositoryUrl") {
      lines.push(
        auditChange(
          LABELS.repositoryUrl,
          projectRepositoryUrl(before),
          projectRepositoryUrl(after),
          auditUrl
        )
      );
    } else if (key === "estimateFieldId") {
      lines.push(
        auditChange(
          "Estimate field",
          fieldName(before, before.estimateFieldId),
          fieldName(after, after.estimateFieldId)
        )
      );
    } else if (key === "pm" || key.startsWith("pm.")) {
      pm = true;
    } else if (key.startsWith("worker.policy")) {
      policy = true;
    } else if (key in LABELS) {
      const show = URLS.has(key) ? auditUrl : auditValue;
      lines.push(auditChange(LABELS[key], at(before, key), at(after, key), show));
    } else if (!same(at(before, key), at(after, key))) {
      lines.push(`${key} changed`);
    }
  }

  return [
    ...lines.filter((line): line is string => line !== null),
    ...(pm ? pmChanges(before, after) : []),
    ...(policy ? policyChanges(before, after) : []),
  ];
}
