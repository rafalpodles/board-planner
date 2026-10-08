import { NextResponse } from "next/server";
import { askBilling } from "@/lib/billing-client";
import { memberCounts } from "@/lib/member-limit";
import { withAdmin } from "@/lib/middleware";
import { organisationDomain, organisationOrigin } from "@/lib/organisation-host";
import { billingRefusal } from "@/lib/billing-refusal";
import { paymentUrl } from "@/lib/payment-url";

export const POST = withAdmin(async (request, { user, db }) => {
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json({ error: "Payment is not available here" }, { status: 404 });
  const body = await request.json().catch(() => null);
  const interval = body?.interval;
  if (interval !== "month" && interval !== "year") return NextResponse.json({ error: "interval must be month or year" }, { status: 400 });
  const origin = await organisationOrigin(db.organisation);
  if (!origin) return NextResponse.json({ error: "This organisation has no address to return to" }, { status: 409 });

  const { active, pending } = await memberCounts(db);
  const answer = await askBilling("checkout", {
    organisation: db.organisation.toHexString(),
    interval,
    members: active + pending,
    email: user.email,
    successUrl: `${origin}/settings/organisation?checkout=success`,
    cancelUrl: `${origin}/settings/organisation?checkout=cancelled`,
  });
  const url = answer.status === "ok" ? paymentUrl(answer.body.url) : null;
  return url ? NextResponse.json({ url }) : billingRefusal(answer);
});
