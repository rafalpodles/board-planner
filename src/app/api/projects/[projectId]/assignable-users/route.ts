import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { projectAudienceFilter } from "@/lib/grants";
import { User } from "@/models/user";

// Everyone this board may hand work to, and everyone its editors may @mention: the same question
// decide() answers, asked as a query rather than as a filter over a list handed in. It replaces
// /api/users/list, which asked no question at all and gave every signed-in person the whole
// instance's roster.
//
// Machines are excluded: a worker identity is an author and an assignee, never someone a person
// picks from a list. Instance admins are included and hold no grant — leaving them out would take
// the only admin on a small instance out of every picker on it.
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
