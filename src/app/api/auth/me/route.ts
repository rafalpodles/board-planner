import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again later." },
      { status: 429 }
    );
  }

  const user = await getAuthUser(request);

  if (!user) {
    recordFailedAttempt(ip);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  clearAttempts(ip);

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
