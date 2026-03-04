import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";

export async function GET(request: Request) {
  const user = await getAuthUser(request);

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
