import { NextResponse } from "next/server";
import { cancelEmailChange, pendingEmailChange } from "@/lib/email-change";
import { withAuth } from "@/lib/middleware";

export const GET = withAuth(async (_request, { user }) => {
  return NextResponse.json({ pending: await pendingEmailChange(user._id) });
});

export const DELETE = withAuth(async (_request, { user }) => {
  await cancelEmailChange(user._id);
  return NextResponse.json({ pending: null });
});
