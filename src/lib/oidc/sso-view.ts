import type { ScopedDb } from "@/lib/db-scope";
import { can } from "@/lib/entitlements";
import { decryptSecret } from "@/lib/encryption";
import { returnAddress } from "@/lib/oidc/flow";
import { SSO_LABEL_DEFAULT } from "@/lib/oidc/organisation-sso";
import { getOrganisation } from "@/lib/organisation";
import { originFor } from "@/lib/organisation-host";

export async function ssoView(db: ScopedDb) {
  const [settings, organisation, origin] = await Promise.all([db.Settings.findOne({}, "sso").lean(), getOrganisation(db.organisation), originFor(db)]);
  const sso = settings?.sso;
  const available = can(organisation, "identity.sso");
  let unreadable = false;
  if (sso) {
    try {
      decryptSecret(sso.clientSecret, db.organisation);
    } catch {
      // Sealed under a key this server no longer has: the secret has to be entered again
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
    set: !!sso,
    issuer: sso?.issuer ?? "",
    clientId: sso?.clientId ?? "",
    label: sso?.label ?? SSO_LABEL_DEFAULT,
    secretHint: sso?.clientSecretHint ?? "",
    adminGroup: sso?.adminGroup ?? "",
    groupsClaim: sso?.groupsClaim ?? "",
    unreadable,
    // Offered at sign-in right now: stored, readable, and the plan includes it
    active: !!sso && available && !unreadable,
    // Required of everybody, which only holds while it is active
    enforced: !!sso && sso.enforced === true && available && !unreadable,
    redirectUri: origin ? returnAddress({ id: "oidc" }, origin) : null,
  };
}
