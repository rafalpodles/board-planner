import { NextResponse } from "next/server";
import { configuredProviders } from "@/lib/oidc/providers";
import { Identity } from "@/models/identity";
import { User } from "@/models/user";

/** `PASSWORD_SIGN_IN`: unset or `on` keeps passwords, `off` leaves the sign-in providers alone. */
export function passwordSignInEnabled(): boolean {
  return process.env.PASSWORD_SIGN_IN?.trim().toLowerCase() !== "off";
}

export const PASSWORD_SIGN_IN_OFF = "Password sign-in is turned off on this instance. Sign in with a provider instead.";

export function passwordSignInOff(): NextResponse {
  return NextResponse.json({ error: PASSWORD_SIGN_IN_OFF }, { status: 403 });
}

/**
 * At startup, so a fumbled value is one failure naming the variable: anything but on/off, and off
 * with no provider configured, which would leave nobody any way in.
 */
export function assertSignInConfig(): void {
  const raw = process.env.PASSWORD_SIGN_IN?.trim().toLowerCase();
  if (raw && raw !== "on" && raw !== "off") {
    throw new Error(`PASSWORD_SIGN_IN must be "on" or "off", not "${process.env.PASSWORD_SIGN_IN}"`);
  }
  if (raw === "off" && configuredProviders().length === 0) {
    throw new Error(
      "PASSWORD_SIGN_IN=off needs a sign-in provider: set OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET"
    );
  }
}

/**
 * Passwords off where no active administrator can sign in through a provider leaves the instance
 * administered only until their sessions lapse, and then by nobody short of a database edit. Null
 * when one can, or when there is no administrator yet to lock out.
 */
export async function adminsLockedOut(): Promise<string | null> {
  if (passwordSignInEnabled()) return null;
  const admins = await User.find({ role: "admin", deactivatedAt: null, kind: { $ne: "machine" } })
    .select("_id emailVerifiedAt")
    .lean();
  if (admins.length === 0) return null;
  const providers = configuredProviders();
  if (providers.some((p) => p.linksByAddress) && admins.some((a) => a.emailVerifiedAt)) return null;
  const linked = await Identity.exists({
    user: { $in: admins.map((a) => a._id) },
    provider: { $in: providers.map((p) => p.id) },
  });
  if (linked) return null;
  return (
    "PASSWORD_SIGN_IN=off, but no active administrator can sign in through a configured provider: none has one linked, " +
    "nor a confirmed address an OpenID Connect or Google provider could link by. Start with passwords on, link a provider " +
    "under Settings → Security (or confirm an administrator's address), then turn passwords off."
  );
}
