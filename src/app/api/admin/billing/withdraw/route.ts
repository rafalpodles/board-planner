import { NextResponse } from "next/server";
import { askBilling } from "@/lib/billing-client";
import { billingRefusal } from "@/lib/billing-refusal";
import { withAdmin } from "@/lib/middleware";
import { organisationDomain } from "@/lib/organisation-host";
import { moneyOf } from "@/lib/subscription-summary";

export const POST = withAdmin(async (_request, { user, db }) => {
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json({ error: "Payment is not available here" }, { status: 404 });

  const answer = await askBilling("withdraw", { organisation: db.organisation.toHexString() });
  if (answer.status === "ok") {
    return NextResponse.json({ withdrawn: true, at: typeof answer.body.at === "string" ? answer.body.at : null, refunded: moneyOf(answer.body.refunded, "amount") });
  }
  if (answer.status === "refused" && answer.httpStatus === 409) {
    return NextResponse.json({ error: "This subscription can no longer be withdrawn from. Reload the page to see where it stands." }, { status: 409 });
  }
  return billingRefusal(answer);
});
