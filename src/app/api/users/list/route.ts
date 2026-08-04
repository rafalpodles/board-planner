import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { User } from "@/models/user";

// Lightweight endpoint for any authenticated user — returns username + fullName only.
// Machines are excluded: a worker identity is an author and an assignee, never someone a person
// picks from a list.
export const GET = withAuth(async () => {
  await connectDB();
  const users = await User.find({ kind: { $ne: "machine" } }, "username fullName").sort({ username: 1 }).lean();
  return NextResponse.json(users);
});
