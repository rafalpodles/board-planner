import type { ScopedDb } from "@/lib/db-scope";
import { decryptSecret } from "@/lib/encryption";
import { can } from "@/lib/entitlements";
import { getOrganisation } from "@/lib/organisation";

export async function smtpView(db: ScopedDb) {
  const [settings, organisation] = await Promise.all([db.Settings.findOne({}, "smtp").lean(), getOrganisation(db.organisation)]);
  const smtp = settings?.smtp;
  const available = can(organisation, "email.smtp");
  let unreadable = false;
  if (smtp) {
    try {
      decryptSecret(smtp.password, db.organisation);
    } catch {
      unreadable = true;
    }
  }
  const trial = organisation.entitlements.trial === true;
  return {
    hosted: true,
    plan: organisation.entitlements.plan,
    trial,
    trialEndsAt: trial && organisation.entitlements.expiresAt ? new Date(organisation.entitlements.expiresAt).toISOString() : null,
    available,
    set: !!smtp,
    host: smtp?.host ?? "",
    port: smtp?.port ?? 587,
    user: smtp?.user ?? "",
    fromAddress: smtp?.fromAddress ?? "",
    fromName: smtp?.fromName ?? "",
    unreadable,
    // Mail goes through it right now: stored, readable, and the plan includes it
    active: !!smtp && available && !unreadable,
  };
}
