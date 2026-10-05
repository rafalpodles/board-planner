import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { organisationDomain } from "@/lib/organisation-host";
import { logProjectAudit } from "@/lib/projectAudit";
import { isWebhookSigningConfigured, webhookSigningSecret } from "@/lib/webhook-signature";

export type WebhookSigning = { signing: "off" } | { signing: "instance" } | { signing: "project"; secret: string };

const interactiveOnly = () => NextResponse.json({ error: "Interactive session required" }, { status: 403 });
const answer = (body: WebhookSigning) => NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

// The project's own key, for the receivers its owner points deliveries at. The instance's secret is
// never served: on a single-organisation instance it is the operator's, set in the environment
export const GET = withProjectOwner(async (_request, { params, user, db }) => {
  if (user.viaMachineCredential) return interactiveOnly();
  if (!isWebhookSigningConfigured()) return answer({ signing: "off" });
  if (!organisationDomain()) return answer({ signing: "instance" });
  const { projectId } = await params;
  await connectDB();
  const project = await db.Project.findById(projectId, "webhookSigningVersion").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  await logProjectAudit(db, project._id, user._id, "webhook_secret_revealed");
  return answer({ signing: "project", secret: webhookSigningSecret(db.organisation, project) });
});

// Retires the key a former owner may still hold: every receiver needs the new one
export const POST = withProjectOwner(async (_request, { params, user, db }) => {
  if (user.viaMachineCredential) return interactiveOnly();
  if (!isWebhookSigningConfigured() || !organisationDomain()) {
    return NextResponse.json({ error: "This instance signs with one secret set by its operator" }, { status: 409 });
  }
  const { projectId } = await params;
  await connectDB();
  const project = await db.Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { webhookSigningVersion: 1 } },
    { returnDocument: "after", projection: { webhookSigningVersion: 1 } }
  ).lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  await logProjectAudit(db, project._id, user._id, "webhook_secret_rotated", `version ${project.webhookSigningVersion}`);
  return answer({ signing: "project", secret: webhookSigningSecret(db.organisation, project) });
});
