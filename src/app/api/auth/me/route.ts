import { NextResponse } from "next/server";
import { getAuthUser, RateLimitError } from "@/lib/auth";

export async function GET(request: Request) {
  let user;
  try {
    user = await getAuthUser(request);
  } catch (e) {
    if (e instanceof RateLimitError) {
      return NextResponse.json({ error: e.message }, { status: 429 });
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
    role: user.role || "member",
    allowedProjects: user.allowedProjects || [],
    createdAt: user.createdAt,
  });
}
