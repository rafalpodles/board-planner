import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAdmin } from "@/lib/middleware";
import { passwordSignInFor, warnIfAdminsLockedOut } from "@/lib/password-sign-in";
import { isSwitchable, membersOnlyThrough, providerSwitchView } from "@/lib/oidc/provider-switch";
import { providersFor } from "@/lib/oidc/providers";
import { organisationDomain } from "@/lib/organisation-host";
import { readJsonBody } from "@/lib/request-body";
import { writeSettings } from "@/lib/settings-write";

const CLOUD_ONLY = { error: "Here the sign-in providers come from the environment; in the cloud an organisation switches each one on or off" };

export const GET = withAdmin(async (_request, { db }) => {
  if (organisationDomain() === null) return NextResponse.json({ hosted: false });
  await connectDB();
  return NextResponse.json(await providerSwitchView(db));
});

export const PUT = withAdmin(async (request, { user, db }) => {
  // A way into every account is changed by a person at the screen, never by a token that holds one
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json(CLOUD_ONLY, { status: 404 });

  const read = await readJsonBody<{ provider?: unknown; enabled?: unknown; confirm?: unknown }>(request);
  if (!read.ok) return read.response;
  const { provider, enabled, confirm } = read.value;
  if (!isSwitchable(provider)) return NextResponse.json({ error: "That sign-in provider cannot be switched here" }, { status: 400 });
  if (typeof enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });

  await connectDB();
  const current = (await providerSwitchView(db)).providers.find((p) => p.id === provider);
  if (current?.enabled !== enabled) {
    const label = current?.label ?? provider;
    // Where passwords do not sign in, the last provider offered is the last way in for everybody: no confirmation lifts that
    const lastWayIn = `Passwords do not sign in here, so ${label} is the only way in. Turn another sign-in on, or set up your own single sign-on, first.`;
    if (!enabled && !(await passwordSignInFor(db)) && (await providersFor(db)).every((p) => p.id === provider)) {
      return NextResponse.json({ error: lastWayIn }, { status: 409 });
    }
    if (!enabled && confirm !== true) {
      const affected = await membersOnlyThrough(db, provider);
      if (affected > 0) {
        return NextResponse.json(
          {
            error: `${affected} ${affected === 1 ? "member signs" : "members sign"} in only through ${label}. They cannot sign in while it is off.`,
            affected,
          },
          { status: 409 }
        );
      }
    }
    await writeSettings(db, enabled ? { $pull: { disabledProviders: provider } } : { $addToSet: { disabledProviders: provider } });
    // Two administrators switching off the last two providers at once each saw the other still on: read again, and put this one back
    if (!enabled && !(await passwordSignInFor(db)) && (await providersFor(db)).length === 0) {
      await writeSettings(db, { $pull: { disabledProviders: provider } });
      return NextResponse.json({ error: lastWayIn }, { status: 409 });
    }
    void logInstanceAudit(db, {
      action: "instance_settings_changed",
      user: user._id,
      actorUsername: user.username,
      detail: `sign-in with ${label}: ${enabled ? "turned on" : "turned off"}`,
    });
    if (!enabled) void warnIfAdminsLockedOut(db, "a sign-in provider being switched off");
  }
  return NextResponse.json(await providerSwitchView(db));
});
