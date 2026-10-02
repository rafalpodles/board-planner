import { NextResponse } from "next/server";
import { withAuth } from "@/lib/middleware";
import { connectDB } from "@/lib/db";
import { providerById } from "@/lib/oidc/providers";
import { Identity } from "@/models/identity";
import { User } from "@/models/user";

export const GET = withAuth(async (_request, { user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 });
  }
  await connectDB();
  const [identities, record] = await Promise.all([
    Identity.find({ user: user._id }).sort({ linkedAt: 1 }).lean(),
    User.findById(user._id).select("+password").lean(),
  ]);
  return NextResponse.json({
    hasPassword: !!record?.password,
    identities: identities.map((i) => ({
      _id: String(i._id),
      provider: i.provider,
      label: providerById(i.provider)?.label ?? i.provider,
      email: i.email,
      linkedAt: i.linkedAt,
      lastUsedAt: i.lastUsedAt,
    })),
  });
});
