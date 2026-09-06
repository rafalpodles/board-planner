import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { databaseUnavailable } from "@/lib/middleware";
import { User } from "@/models/user";

export async function GET() {
  try {
    await connectDB();
    const users = await User.countDocuments();
    return NextResponse.json({ unclaimed: users === 0 });
  } catch (e) {
    if (isDatabaseUnreachable(e)) return databaseUnavailable();
    throw e;
  }
}
