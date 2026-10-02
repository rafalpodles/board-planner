import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withAuth } from "@/lib/middleware";
import { connectDB } from "@/lib/db";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { providerById } from "@/lib/oidc/providers";
import { Identity } from "@/models/identity";
import { User } from "@/models/user";

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

  const [record, others] = await Promise.all([
    User.findById(user._id).select("+password").lean(),
    Identity.countDocuments({ user: user._id, _id: { $ne: identity._id } }),
  ]);
  if (!record?.password && others === 0) {
    return NextResponse.json(
      { error: "This is your only way to sign in. Set a password first, from Forgot your password." },
      { status: 409 }
    );
  }
  await Identity.deleteOne({ _id: identity._id, user: user._id });

  void logInstanceAudit({
    action: "identity_unlinked",
    user: user._id,
    actorUsername: user.username,
    target: user.username,
    detail: providerById(identity.provider)?.label ?? identity.provider,
  });
  return NextResponse.json({ ok: true });
});
