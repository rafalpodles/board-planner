import { NextResponse } from "next/server";
import { askBilling } from "@/lib/billing-client";
import { billingRefusal } from "@/lib/billing-refusal";
import { paymentUrl } from "@/lib/payment-url";
import { withAdmin } from "@/lib/middleware";
import { organisationDomain, organisationOrigin } from "@/lib/organisation-host";

export const POST = withAdmin(async (_request, { user, db }) => {
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json({ error: "Payment is not available here" }, { status: 404 });
  const origin = await organisationOrigin(db.organisation);
  if (!origin) return NextResponse.json({ error: "This organisation has no address to return to" }, { status: 409 });

  const answer = await askBilling("portal", { organisation: db.organisation.toHexString(), returnUrl: `${origin}/settings/organisation` });
  const url = answer.status === "ok" ? paymentUrl(answer.body.url) : null;
  return url ? NextResponse.json({ url }) : billingRefusal(answer);
});
