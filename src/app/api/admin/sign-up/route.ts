import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { parseSignUpDomains } from "@/lib/sign-up-domains";
import { adminGroup } from "@/lib/oidc/admin-group";
import { configuredProviders } from "@/lib/oidc/providers";
import { getSettings, updateSettings } from "@/models/settings";

function view(domains: string[]) {
  const providers = configuredProviders();
  const oidc = providers.find((p) => p.id === "oidc");
  const group = adminGroup();
  return {
    domains,
    // GitHub's `verified` proves no domain, so only these can open sign-up
    providers: providers.filter((p) => p.linksByAddress).map((p) => p.label),
    adminGroup: oidc && group ? { group, provider: oidc.label } : null,
  };
}

export const GET = withAdmin(async (_request, { db }) => {
  await connectDB();
  return NextResponse.json(view((await getSettings(db)).signUpDomains ?? []));
});

export const PUT = withAdmin(async (request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }
  const read = await readJsonBody<{ domains?: unknown }>(request);
  if (!read.ok) return read.response;
  const parsed = parseSignUpDomains(read.value.domains);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  await connectDB();
  const before = (await getSettings(db)).signUpDomains ?? [];
  const settings = await updateSettings(db, { $set: { signUpDomains: parsed.value } });
  void logInstanceAudit(db, {
    action: "instance_settings_changed",
    user: user._id,
    actorUsername: user.username,
    detail: `sign-up domains: ${before.join(", ") || "none"} → ${parsed.value.join(", ") || "none"}`,
  });
  return NextResponse.json(view(settings.signUpDomains ?? []));
});
