import type { LicenceVerdict } from "@/lib/licence";

export const LICENCE_DOCS_URL =
  "https://board-planner.com/docs/administration/installing-and-running/#licence-key";

export const EXPIRY_WARNING_DAYS = 30;

export type LicenceSummary =
  | { configured: false }
  | { configured: true; verdict: "invalid_signature" | "unknown_key" | "malformed" | "wrong_organisation" }
  | {
      configured: true;
      verdict: "valid" | "grace" | "expired";
      customer: string;
      trial?: boolean;
      subscription?: "renewing" | "ending" | null;
      plan: string;
      features: string[];
      issuedAt: string;
      expiresAt: string;
      graceEndsAt: string;
      daysLeft: number;
      keyId: string;
    };

const REFUSALS: Record<"invalid_signature" | "unknown_key" | "malformed" | "wrong_organisation", string> = {
  wrong_organisation: "The licence key was issued for another organisation.",
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

function expiresWhen(daysLeft: number): string {
  if (daysLeft <= 0) return "today";
  if (daysLeft === 1) return "tomorrow";
  return `in ${daysLeft} days`;
}

function Notice({ verdict, daysLeft, expiresAt, graceEndsAt, trial, subscription }: {
  verdict: LicenceVerdict;
  daysLeft: number;
  expiresAt: string;
  graceEndsAt: string;
  trial?: boolean;
  subscription?: "renewing" | "ending" | null;
}) {
  // The key ends with its UTC day and the renewal is paid some time after the period ends: that day is the renewal's, not a failure
  if (verdict === "grace" && subscription === "renewing" && daysLeft >= -1) return null;
  if (verdict === "grace" && subscription === "renewing") {
    return (
      <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger" data-testid="licence-warning">
        The last payment failed. The paid period ended on {formatDate(expiresAt)}; Pro stays on until {formatDate(graceEndsAt)} while the payment is
        retried, then this organisation moves to the Free plan. No data is removed.
      </p>
    );
  }
  if (verdict === "grace") {
    return (
      <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger" data-testid="licence-warning">
        This licence expired on {formatDate(expiresAt)}. It stays in force until {formatDate(graceEndsAt)},
        then this instance moves to the Free plan. No data is removed.
      </p>
    );
  }
  if (verdict === "expired" && subscription === "ending") {
    return (
      <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger" data-testid="licence-warning">
        This subscription ended on {formatDate(expiresAt)}, so this organisation is on the Free plan. No data was removed, and subscribing again restores
        the plan.
      </p>
    );
  }
  if (verdict === "expired" && trial) {
    return (
      <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger" data-testid="licence-warning">
        This trial ended on {formatDate(expiresAt)}, so this instance is on the Free plan. No data was removed,
        and a licence key restores the plan.
      </p>
    );
  }
  if (verdict === "expired") {
    return (
      <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger" data-testid="licence-warning">
        This licence expired on {formatDate(expiresAt)} and its grace period ended on{" "}
        {formatDate(graceEndsAt)}, so this instance is on the Free plan. No data was removed, and a
        renewed key restores the licence.
      </p>
    );
  }
  if (subscription === "ending") {
    return (
      <p role="status" className="mb-4 rounded-lg border border-border p-4 text-sm" data-testid="licence-warning">
        This subscription is cancelled: Pro ends on {formatDate(expiresAt)}, then this organisation is on the Free plan. No data is removed.
      </p>
    );
  }
  // The key of a subscription that renews by itself is replaced at each renewal: nothing to renew by hand
  if (subscription === "renewing") return null;
  if (trial) {
    return (
      <p role="status" className="mb-4 rounded-lg border border-border p-4 text-sm" data-testid="licence-warning">
        This trial ends {expiresWhen(daysLeft)}, on {formatDate(expiresAt)}. After that this instance is on the Free plan unless a licence key is set.
      </p>
    );
  }
  if (daysLeft <= EXPIRY_WARNING_DAYS) {
    return (
      <p role="status" className="mb-4 rounded-lg border border-border p-4 text-sm" data-testid="licence-warning">
        This licence expires {expiresWhen(daysLeft)}, on {formatDate(expiresAt)}. Renew it before then.
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
    ["Plan", licence.verdict === "expired" ? `${planName(licence.plan)} (expired)` : licence.trial ? `${planName(licence.plan)} (trial)` : planName(licence.plan)],
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
        expiresAt={licence.expiresAt}
        graceEndsAt={licence.graceEndsAt}
        trial={licence.trial}
        subscription={licence.subscription}
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
