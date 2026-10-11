import type { ScopedDb } from "@/lib/db-scope";
import { passwordSignInEnabled, passwordSignInFor } from "@/lib/password-sign-in";
import { SWITCHABLE_PROVIDERS, liveIdentityFilter, providersFor, sharedProviders, ssoEnforced, type OidcProviderId } from "@/lib/oidc/providers";

export interface ProviderSwitchView {
  hosted: true;
  /** Required single sign-on closes Google and GitHub whatever is set here */
  enforced: boolean;
  /** Whether a password signs anybody in here: it decides what to tell people left with no way in */
  passwordSignIn: boolean;
  providers: { id: OidcProviderId; label: string; enabled: boolean }[];
}

export const isSwitchable = (id: unknown): id is OidcProviderId =>
  typeof id === "string" && sharedProviders().some((p) => p.id === id && SWITCHABLE_PROVIDERS.includes(p.id));

export async function providerSwitchView(db: ScopedDb): Promise<ProviderSwitchView> {
  const off = new Set((await db.Settings.findOne({}, "disabledProviders").lean())?.disabledProviders ?? []);
  return {
    hosted: true,
    enforced: await ssoEnforced(db),
    passwordSignIn: await passwordSignInFor(db),
    providers: sharedProviders()
      .filter((p) => SWITCHABLE_PROVIDERS.includes(p.id))
      .map(({ id, label }) => ({ id, label, enabled: !off.has(id) })),
  };
}

/**
 * Active members who would be left with no way in if this provider stopped being offered: linked to it, with no
 * password that signs in and no live link to a provider that remains. An approximation: a member who could still
 * reset a password by e-mail is counted, and one who never linked it is not.
 */
export async function membersOnlyThrough(db: ScopedDb, id: OidcProviderId): Promise<number> {
  const provider = sharedProviders().find((p) => p.id === id);
  // Required single sign-on has closed Google and GitHub already: switching one changes nothing for anybody
  if (!provider || (await ssoEnforced(db))) return 0;
  const linked = await db.Identity.find({ provider: id, ...liveIdentityFilter([provider]) }).select("user").lean();
  const candidates = [...new Set(linked.map((identity) => String(identity.user)))];
  if (candidates.length === 0) return 0;

  const active = await db.User.find({
    _id: { $in: candidates },
    deactivatedAt: null,
    kind: { $ne: "machine" },
    ...(passwordSignInEnabled() ? { $or: [{ password: { $exists: false } }, { password: null }, { password: "" }] } : {}),
  })
    .select("_id")
    .lean();
  if (active.length === 0) return 0;

  const remaining = (await providersFor(db)).filter((p) => p.id !== id);
  const stillIn = new Set(
    (await db.Identity.find({ user: { $in: active.map((user) => user._id) }, ...liveIdentityFilter(remaining) }).select("user").lean()).map((identity) => String(identity.user))
  );
  return active.filter((user) => !stillIn.has(String(user._id))).length;
}
