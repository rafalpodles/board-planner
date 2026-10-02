import type { LicenceVerdict } from "@/lib/licence";

export const LICENCE_DOCS_URL =
  "https://board-planner.com/docs/administration/installing-and-running/#licence-key";

export const EXPIRY_WARNING_DAYS = 30;

export type LicenceSummary =
  | { configured: false }
  | { configured: true; verdict: "invalid_signature" | "unknown_key" | "malformed" }
  | {
      configured: true;
      verdict: "valid" | "grace" | "expired";
      customer: string;
      plan: string;
      features: string[];
      issuedAt: string;
      expiresAt: string;
      graceEndsAt: string;
      daysLeft: number;
      graceDaysLeft: number;
      keyId: string;
    };

const REFUSALS: Record<"invalid_signature" | "unknown_key" | "malformed", string> = {
  unknown_key: "The key in LICENCE_KEY was signed by a key this build does not know.",
  invalid_signature: "The key in LICENCE_KEY has been altered: its signature does not match its contents.",
  malformed: "The value in LICENCE_KEY is not a licence key. It may be truncated or mistyped.",
};

// Licences are dated in UTC: one signed to expire on a day ends at 23:59:59Z, which a viewer east of
// Greenwich would otherwise read as the next day
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function planName(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function days(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function FreePlan({ reason }: { reason?: string }) {
  return (
    <div className="rounded-lg border border-border p-4 text-sm" data-testid="licence-free">
      <p className="font-medium">Free plan</p>
      {reason && (
        <p role="alert" className="mt-1 text-danger" data-testid="licence-refusal">
          {reason}
        </p>
      )}
      <p className="mt-1 text-text-muted">
        <a href={LICENCE_DOCS_URL} target="_blank" rel="noreferrer" className="underline">
          About licences
        </a>
      </p>
    </div>
  );
}

function Notice({ verdict, daysLeft, graceDaysLeft, expiresAt, graceEndsAt }: {
  verdict: LicenceVerdict;
  daysLeft: number;
  graceDaysLeft: number;
  expiresAt: string;
  graceEndsAt: string;
}) {
  if (verdict === "grace") {
    return (
      <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger" data-testid="licence-warning">
        This licence has expired. Pro features stay on for {days(graceDaysLeft)}, until{" "}
        {formatDate(graceEndsAt)}, then switch off. No data is removed.
      </p>
    );
  }
  if (verdict === "expired") {
    return (
      <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger" data-testid="licence-warning">
        This licence has expired and its grace period is over, so this instance is on the Free plan. No
        data was removed; a renewed key turns the features back on.
      </p>
    );
  }
  if (daysLeft <= EXPIRY_WARNING_DAYS) {
    return (
      <p role="status" className="mb-4 rounded-lg border border-border p-4 text-sm" data-testid="licence-warning">
        This licence expires {daysLeft > 0 ? `in ${days(daysLeft)}` : "today"}, on{" "}
        {formatDate(expiresAt)}. Renew it to keep Pro features on.
      </p>
    );
  }
  return null;
}

export function LicenceDetails({ licence }: { licence: LicenceSummary }) {
  if (!licence.configured) return <FreePlan />;
  if (!("customer" in licence)) return <FreePlan reason={REFUSALS[licence.verdict]} />;

  const rows: [string, string][] = [
    ["Customer", licence.customer],
    ["Plan", licence.verdict === "expired" ? `${planName(licence.plan)} (expired)` : planName(licence.plan)],
    ["Features", licence.plan === "pro" ? "All" : licence.features.join(", ") || "None"],
    ["Issued", formatDate(licence.issuedAt)],
    ["Expires", formatDate(licence.expiresAt)],
    ["Days left", licence.daysLeft > 0 ? String(licence.daysLeft) : "0"],
  ];

  return (
    <>
      <Notice
        verdict={licence.verdict}
        daysLeft={licence.daysLeft}
        graceDaysLeft={licence.graceDaysLeft}
        expiresAt={licence.expiresAt}
        graceEndsAt={licence.graceEndsAt}
      />
      <dl className="divide-y divide-border rounded-lg border border-border text-sm" data-testid="licence-details">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4 px-4 py-2">
            <dt className="w-24 shrink-0 text-text-muted sm:w-48">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
