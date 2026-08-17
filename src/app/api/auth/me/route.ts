import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { ProvenanceError } from "@/lib/session";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { databaseUnavailable } from "@/lib/middleware";

export async function GET(request: Request) {
  let user;
  try {
    user = await getAuthUser(request);
  } catch (e) {
    if (e instanceof ProvenanceError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // This route decides whether the app thinks anyone is signed in, so a 401 here is the one that
    // sends somebody to a sign-in screen they cannot get past either (BP-362)
    if (isDatabaseUnreachable(e)) return databaseUnavailable();
    throw e;
  }

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    _id: user._id,
    username: user.username,
    fullName: user.fullName,
    email: user.email || "",
    emailNotifications: user.emailNotifications || false,
    collapseEmptyColumns: user.collapseEmptyColumns ?? true,
    role: user.role || "member",
    createdAt: user.createdAt,
  });
}
