import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { escapeRegex } from "@/lib/github";
import { User } from "@/models/user";
import { Grant } from "@/models/grant";

const MIN_QUERY = 2;
const MAX_RESULTS = 10;

export const GET = withProjectOwner(async (request, { params }) => {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < MIN_QUERY) {
    return NextResponse.json([]);
  }

  const { projectId } = await params;
  await connectDB();

  const grants = await Grant.find({ objectType: "project", object: projectId })
    .select("subject")
    .lean();
  const grantedIds = grants.map((g) => g.subject);

  const pattern = new RegExp(escapeRegex(q), "i");
  const users = await User.find({
    kind: { $ne: "machine" },
    _id: { $nin: grantedIds },
    $or: [{ username: pattern }, { fullName: pattern }],
  })
    .select("username fullName")
    .sort({ username: 1 })
    .limit(MAX_RESULTS)
    .lean();

  return NextResponse.json(
    users.map((u) => ({ _id: String(u._id), username: u.username, fullName: u.fullName }))
  );
});
