import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getAuthUser } from "@/lib/auth";
import { withAdmin } from "@/lib/middleware";
import { User } from "@/models/user";

export const GET = withAdmin(async () => {
  await connectDB();
  const users = await User.find().sort({ createdAt: 1 });
  return NextResponse.json(users);
});

export async function POST(request: Request) {
  await connectDB();

  const body = await request.json();
  const { username, password, fullName } = body;

  if (!username || !password || !fullName) {
    return NextResponse.json(
      { error: "username, password, and fullName are required" },
      { status: 400 }
    );
  }

  const userCount = await User.countDocuments();
  const isBootstrap = userCount === 0;

  if (!isBootstrap) {
    const authUser = await getAuthUser(request);
    if (!authUser || authUser.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    const user = await User.create({
      username: username.toLowerCase(),
      password: hashedPassword,
      fullName,
      role: isBootstrap ? "admin" : "member",
    });
    return NextResponse.json(user, { status: 201 });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      return NextResponse.json(
        { error: "Username already exists" },
        { status: 409 }
      );
    }
    throw err;
  }
}
