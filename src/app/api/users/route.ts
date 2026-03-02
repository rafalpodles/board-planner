import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getAuthUser } from "@/lib/auth";
import { withAuth } from "@/lib/middleware";
import { User } from "@/models/user";

export const GET = withAuth(async () => {
  await connectDB();
  const users = await User.find().sort({ createdAt: 1 });
  return NextResponse.json(users);
});

export async function POST(request: Request) {
  await connectDB();

  const userCount = await User.countDocuments();
  const isBootstrap = userCount === 0;

  if (!isBootstrap) {
    const authUser = await getAuthUser(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = await request.json();
  const { username, password, fullName } = body;

  if (!username || !password || !fullName) {
    return NextResponse.json(
      { error: "username, password, and fullName are required" },
      { status: 400 }
    );
  }

  const existing = await User.findOne({ username: username.toLowerCase() });
  if (existing) {
    return NextResponse.json(
      { error: "Username already exists" },
      { status: 409 }
    );
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await User.create({
    username,
    password: hashedPassword,
    fullName,
  });

  return NextResponse.json(user, { status: 201 });
}
