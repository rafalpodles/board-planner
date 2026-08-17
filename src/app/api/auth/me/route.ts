import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { ProvenanceError } from "@/lib/session";

export async function GET(request: Request) {
  let user;
  try {
    user = await getAuthUser(request);
  } catch (e) {
    if (e instanceof ProvenanceError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
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
    emailDigest: user.emailDigest || false,
    collapseEmptyColumns: user.collapseEmptyColumns ?? true,
    role: user.role || "member",
    createdAt: user.createdAt,
  });
}
