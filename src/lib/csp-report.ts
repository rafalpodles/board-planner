export const MAX_REPORT_BYTES = 16 * 1024;
export const REPORTS_PER_MINUTE = 60;
const MAX_REPORTS_PER_REQUEST = 10;
const MAX_FIELD_LENGTH = 300;

export const ACCEPTED_REPORT_TYPES = new Set(["application/csp-report", "application/reports+json", "application/json"]);

export interface CspViolation {
  documentUrl: string | null;
  directive: string | null;
  blockedUrl: string | null;
  sourceFile: string | null;
  lineNumber: number | null;
  disposition: string | null;
  sample: string | null;
}

let windowStartedAt = 0;
let loggedInWindow = 0;
let droppedInWindow = 0;

export function resetCspReportWindow() {
  windowStartedAt = 0;
  loggedInWindow = 0;
  droppedInWindow = 0;
}

function text(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.slice(0, MAX_FIELD_LENGTH);
}

function withoutQuery(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, MAX_FIELD_LENGTH);
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

function lineNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseViolations(body: unknown): CspViolation[] {
  const legacy = asRecord(asRecord(body)?.["csp-report"]);
  if (legacy) {
    return [
      {
        documentUrl: withoutQuery(legacy["document-uri"]),
        directive: text(legacy["effective-directive"]) ?? text(legacy["violated-directive"]),
        blockedUrl: withoutQuery(legacy["blocked-uri"]),
        sourceFile: withoutQuery(legacy["source-file"]),
        lineNumber: lineNumber(legacy["line-number"]),
        disposition: text(legacy.disposition),
        sample: text(legacy["script-sample"]),
      },
    ];
  }
  if (!Array.isArray(body)) return [];
  return body.slice(0, MAX_REPORTS_PER_REQUEST).flatMap((entry) => {
    const report = asRecord(entry);
    const detail = asRecord(report?.body);
    if (!report || report.type !== "csp-violation" || !detail) return [];
    return [
      {
        documentUrl: withoutQuery(detail.documentURL ?? report.url),
        directive: text(detail.effectiveDirective),
        blockedUrl: withoutQuery(detail.blockedURL),
        sourceFile: withoutQuery(detail.sourceFile),
        lineNumber: lineNumber(detail.lineNumber),
        disposition: text(detail.disposition),
        sample: text(detail.sample),
      },
    ];
  });
}

export function admitReport(now: number): boolean {
  if (now - windowStartedAt >= 60_000) {
    if (droppedInWindow > 0) {
      console.warn(JSON.stringify({ event: "csp-violation-dropped", count: droppedInWindow }));
    }
    windowStartedAt = now;
    loggedInWindow = 0;
    droppedInWindow = 0;
  }
  if (loggedInWindow >= REPORTS_PER_MINUTE) {
    droppedInWindow++;
    return false;
  }
  loggedInWindow++;
  return true;
}

