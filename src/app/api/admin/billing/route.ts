import { NextResponse } from "next/server";
import { askBilling } from "@/lib/billing-client";
import { withAdmin } from "@/lib/middleware";
import { organisationDomain } from "@/lib/organisation-host";
import { subscriptionSummary } from "@/lib/subscription-summary";

export const GET = withAdmin(async (_request, { db }) => {
  if (organisationDomain() === null) return NextResponse.json({ available: false });
  const answer = await askBilling("status", { organisation: db.organisation.toHexString() });
  if (answer.status === "off") return NextResponse.json({ available: false });
  if (answer.status !== "ok") return NextResponse.json({ available: false, unreachable: true });
  return NextResponse.json({ available: true, launchOpen: answer.body.launchOpen === true, subscription: subscriptionSummary(answer.body.subscription) });
});
