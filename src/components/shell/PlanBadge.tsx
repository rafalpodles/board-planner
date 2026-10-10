"use client";

import Link from "next/link";
import { useOrganisation } from "@/hooks/use-organisation";
import { useAuth } from "@/hooks/use-auth";
import { formatPlanDate, graceDaysLeft, planNotice } from "@/lib/plan-notice";

const UPGRADE_HREF = "/settings/licence";

function daysLabel(daysLeft: number): string {
  if (daysLeft <= 1) return "ends within a day";
  return `${daysLeft} days left`;
}

function graceLabel(graceEndsAt: string): string {
  const days = graceDaysLeft(graceEndsAt);
  if (days <= 1) return "last day of grace";
  return `${days} days of grace left`;
}

export function PlanBadge({ compact }: { compact: boolean }) {
  const { organisation } = useOrganisation();
  const { isAdmin } = useAuth();
  if (!organisation) return null;

  const notice = planNotice(organisation);
  const trial = organisation.trial === true && notice.kind !== "free";
  const tone = notice.kind === "grace" ? "text-danger" : notice.kind === "ending" ? "text-warning" : "text-text-muted";
  const title =
    notice.kind === "free"
      ? "Free plan"
      : notice.kind === "pro"
        ? trial ? "Pro trial" : "Pro plan"
        : notice.kind === "ending"
          ? `${trial ? "Pro trial" : notice.cancelled ? "Pro plan, cancelled" : "Pro plan"}, ends ${formatPlanDate(notice.endsAt)}`
          : notice.paymentFailed
            ? `Payment failed, Pro stays on until ${formatPlanDate(notice.graceEndsAt)}`
            : `Pro plan ended ${formatPlanDate(notice.endedAt)}, in force until ${formatPlanDate(notice.graceEndsAt)}`;
  const name = notice.kind === "free" ? "Free" : trial ? "Trial" : "Pro";
  const held = (organisation.members ?? 0) + (organisation.invited ?? 0);
  const limit = isAdmin ? organisation.memberLimit ?? null : null;
  const membersNote = limit !== null && held >= limit ? `${held} of ${limit} members on Free` : null;
  const action =
    notice.kind === "free" || (trial && (notice.kind === "ending" || notice.kind === "pro"))
      ? "Upgrade"
      : notice.kind === "grace" && notice.paymentFailed
        ? "Update payment"
        : notice.kind === "ending" || notice.kind === "grace"
          ? "Renew"
          : null;

  if (compact) {
    return (
      <Link
        href={isAdmin && action ? UPGRADE_HREF : "/settings/organisation"}
        title={title}
        aria-label={title}
        data-testid="plan-badge"
        className={`focus-ring mx-auto mb-2 block rounded-full bg-primary/15 px-2 py-1 text-[11px] font-semibold ${notice.kind === "pro" ? "text-primary-on-tint" : tone}`}
      >
        {name}
      </Link>
    );
  }

  return (
    <div className="mx-2.5 mb-2 rounded-lg border border-border px-2.5 py-2" data-testid="plan-badge">
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary-on-tint">{name}</span>
        <span className={`min-w-0 flex-1 text-xs ${tone}`} data-testid="plan-badge-detail">
          {notice.kind === "free" && "Free plan"}
          {notice.kind === "pro" && (trial && organisation.planEndsAt ? `Ends ${formatPlanDate(organisation.planEndsAt)}` : "Plan active")}
          {notice.kind === "ending" && (notice.cancelled ? `Cancelled · ends ${formatPlanDate(notice.endsAt)}` : `${daysLabel(notice.daysLeft)} · ${formatPlanDate(notice.endsAt)}`)}
          {notice.kind === "grace" && (notice.paymentFailed ? `Payment failed · ${graceLabel(notice.graceEndsAt)}` : `Ended ${formatPlanDate(notice.endedAt)} · until ${formatPlanDate(notice.graceEndsAt)}`)}
        </span>
      </div>
      {membersNote && (
        <p className="mt-1 text-xs text-warning" data-testid="plan-badge-members">
          {membersNote}
        </p>
      )}
      {isAdmin && action && (
        <Link
          href={UPGRADE_HREF}
          data-testid="plan-badge-action"
          className="focus-ring mt-2 flex min-h-[44px] w-full items-center justify-center rounded-md bg-primary-solid px-3 text-xs font-semibold text-white transition-colors hover:bg-primary-solid-hover md:min-h-0 md:py-1.5"
        >
          {action}
        </Link>
      )}
    </div>
  );
}
