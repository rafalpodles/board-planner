import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withAuth } from "@/lib/middleware";
import { connectDB } from "@/lib/db";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { isEmailConfigured } from "@/lib/email";
import { liveIdentityFilter, providerById } from "@/lib/oidc/providers";
import { Identity } from "@/models/identity";
import { User } from "@/models/user";
import { RECENT_SIGN_IN_REQUIRED, signedInRecently } from "@/lib/session";
import { passwordSignInEnabled } from "@/lib/password-sign-in";

export const DELETE = withAuth(async (_request, { params, user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 });
  }
  const { identityId } = await params;
  if (!isValidObjectId(identityId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await connectDB();
  const identity = await Identity.findOne({ _id: identityId, user: user._id }).lean();
  if (!identity) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const record = await User.findById(user._id).select("+password").lean();
  // With password sign-in off a password is no way in, however many accounts still hold one
  const passwordSignsIn = !!record?.password && passwordSignInEnabled();
  const lastWayIn = !passwordSignInEnabled()
    ? "This is your only way to sign in. Link another provider first."
    : isEmailConfigured()
      ? "This is your only way to sign in. Set a password first, from Forgot your password."
      : "This is your only way to sign in. Ask an administrator to set a password for you first.";
  // Only a link a configured provider still signs in through is a way in, on either side of this
  const live = liveIdentityFilter();
  const removesAWayIn = !!(await Identity.exists({ _id: identity._id, ...live }));
  if (
    !passwordSignsIn &&
    removesAWayIn &&
    (await Identity.countDocuments({ user: user._id, _id: { $ne: identity._id }, ...live })) === 0
  ) {
    return NextResponse.json({ error: lastWayIn }, { status: 409 });
  }
  // Removing a way in, with no password left to fall back on, needs the owner and not a borrowed
  // session: otherwise a provider linked by an intruder could be left as the only one
  if (!passwordSignsIn && removesAWayIn && !(await signedInRecently(user.sessionId))) {
    return NextResponse.json({ error: RECENT_SIGN_IN_REQUIRED }, { status: 403 });
  }
  await Identity.deleteOne({ _id: identity._id, user: user._id });
  // Two unlinks in two tabs each counted the other's provider as the way in that remains
  if (!passwordSignsIn && removesAWayIn && (await Identity.countDocuments({ user: user._id, ...live })) === 0) {
    // Straight to the collection, so the row comes back exactly as it was, linkedAt included
    await Identity.collection.insertOne(identity);
    return NextResponse.json({ error: lastWayIn }, { status: 409 });
  }

  void logInstanceAudit({
    action: "identity_unlinked",
    user: user._id,
    actorUsername: user.username,
    target: user.username,
    detail: providerById(identity.provider)?.label ?? identity.provider,
  });
  return NextResponse.json({ ok: true });
});
