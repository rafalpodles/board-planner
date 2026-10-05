import { NextResponse } from "next/server";
import { withProjectOwner } from "@/lib/middleware";
import { organisationDomain } from "@/lib/organisation-host";
import { isWebhookSigningConfigured, webhookSigningSecret } from "@/lib/webhook-signature";

export type WebhookSigning = { signing: "off" } | { signing: "instance" } | { signing: "organisation"; secret: string };

// The organisation's own key, for the receivers a project owner points deliveries at. The instance's
// secret is never served: on a single-organisation instance it is the operator's, set in the environment
export const GET = withProjectOwner(async (_request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }
  let body: WebhookSigning;
  if (!isWebhookSigningConfigured()) body = { signing: "off" };
  else if (!organisationDomain()) body = { signing: "instance" };
  else body = { signing: "organisation", secret: webhookSigningSecret(db.organisation) };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
});
