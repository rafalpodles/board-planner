import { NextResponse } from "next/server";
import type { BillingAnswer } from "./billing-client";

/** What the page is told when the licence service did not hand back a payment page */
export function billingRefusal(answer: BillingAnswer): NextResponse {
  if (answer.status === "off") return NextResponse.json({ error: "Payment is not available here" }, { status: 404 });
  if (answer.status === "refused" && answer.httpStatus === 409) {
    return NextResponse.json({ error: "This organisation already has a subscription", alreadySubscribed: true }, { status: 409 });
  }
  if (answer.status === "refused" && answer.httpStatus === 404) return NextResponse.json({ error: "This organisation has no subscription to manage" }, { status: 404 });
  return NextResponse.json({ error: "Could not reach the payment service. Try again in a moment." }, { status: 502 });
}
