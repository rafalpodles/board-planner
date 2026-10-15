import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { fleetFor } from "@/lib/fleet";

// A person at a browser only, like the reader's own machine list: a token has no sidebar
export const GET = withAuth(async (_request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }
  await connectDB();
  return NextResponse.json(await fleetFor(db, user));
});
