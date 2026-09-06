import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { projectAudienceFilter } from "@/lib/grants";
import { User } from "@/models/user";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const users = await User.find(
    { ...(await projectAudienceFilter(projectId)), kind: { $ne: "machine" } },
    "username fullName"
  )
    .sort({ username: 1 })
    .lean();

  return NextResponse.json(users);
});
