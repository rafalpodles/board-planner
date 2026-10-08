import { NextResponse } from "next/server";
import { askBilling } from "@/lib/billing-client";
import { withAdmin } from "@/lib/middleware";
import { organisationDomain } from "@/lib/organisation-host";

export interface SubscriptionSummary {
  status: string | null;
  interval: "month" | "year" | null;
  launch: boolean;
  extraMembers: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export type BillingSummary = { available: false } | { available: true; launchOpen: boolean; subscription: SubscriptionSummary | null };

export const GET = withAdmin(async (_request, { db }) => {
  if (organisationDomain() === null) return NextResponse.json({ available: false });
  const answer = await askBilling("status", { organisation: db.organisation.toHexString() });
  if (answer.status !== "ok") return NextResponse.json({ available: false });
  return NextResponse.json({ available: true, launchOpen: answer.body.launchOpen === true, subscription: answer.body.subscription ?? null });
});
