import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { User } from "@/models/user";

// Names only: this answers "who can open a board for me" to somebody who may reach no board at
// all, so it must not become a way to list accounts, usernames or addresses.
export const GET = withAuth(async () => {
  await connectDB();
  const admins = await User.find({ role: "admin", kind: { $ne: "machine" } })
    .select("fullName")
    .sort({ fullName: 1 })
    .lean();
  return NextResponse.json(admins.map((admin) => ({ fullName: admin.fullName })));
});
