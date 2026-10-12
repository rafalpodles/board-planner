import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { escapeRegex } from "@/lib/github";

const MIN_QUERY = 2;
const MAX_RESULTS = 10;

// The wizard's counterpart of a board's members/candidates: the same search, for a board that does
// not exist yet and so has no grants to leave out
export const GET = withAdmin(async (request, { user, db }) => {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < MIN_QUERY) return NextResponse.json([]);

  await connectDB();
  const pattern = new RegExp(escapeRegex(q), "i");
  const users = await db.User.find({
    kind: { $ne: "machine" },
    deactivatedAt: null,
    _id: { $ne: user._id },
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
