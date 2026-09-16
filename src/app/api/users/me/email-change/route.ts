import { NextResponse } from "next/server";
import { cancelEmailChange, pendingEmailChange } from "@/lib/email-change";
import { withAuth } from "@/lib/middleware";

// The address that will receive reset links is not a machine's business, as on PUT /api/users/me
const interactiveOnly = () =>
  NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 });

export const GET = withAuth(async (_request, { user }) => {
  if (user.viaMachineCredential) return interactiveOnly();
  return NextResponse.json({ pending: await pendingEmailChange(user._id) });
});

export const DELETE = withAuth(async (_request, { user }) => {
  if (user.viaMachineCredential) return interactiveOnly();
  await cancelEmailChange(user._id);
  return NextResponse.json({ pending: null });
});
