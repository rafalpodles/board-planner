import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { User } from "@/models/user";
import { Grant } from "@/models/grant";
import { GRANT_RELATIONS, GrantRelation } from "@/types";

async function ownerCount(projectId: string): Promise<number> {
  return Grant.countDocuments({ objectType: "project", object: projectId, relation: "owner" });
}

export const GET = withProjectOwner(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const [users, grants] = await Promise.all([
    User.find({ kind: { $ne: "machine" } })
      .select("username fullName role")
      .sort({ username: 1 })
      .lean(),
    Grant.find({ objectType: "project", object: projectId }).select("subject relation").lean(),
  ]);

  const byUser = new Map(grants.map((g) => [String(g.subject), g.relation]));

  return NextResponse.json(
    users.map((u) => ({
      _id: String(u._id),
      username: u.username,
      fullName: u.fullName,
      relation: byUser.get(String(u._id)) ?? null,
      instanceAdmin: u.role === "admin",
    }))
  );
});

export const PUT = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  const body = (await request.json().catch(() => null)) ?? {};
  const { userId, relation } = body as { userId?: string; relation?: GrantRelation };

  if (!userId || !relation || !GRANT_RELATIONS.includes(relation)) {
    return NextResponse.json(
      { error: "userId and a relation of owner or member are required" },
      { status: 400 }
    );
  }

  await connectDB();
  const target = await User.findById(userId).select("_id role kind");
  if (!target || target.kind === "machine") {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (relation !== "owner") {
    const current = await Grant.findOne({ subject: userId, objectType: "project", object: projectId })
      .select("relation")
      .lean();
    if (current?.relation === "owner" && (await ownerCount(projectId)) <= 1) {
      return NextResponse.json(
        { error: "A board must keep at least one owner" },
        { status: 409 }
      );
    }
  }

  try {
    await Grant.updateOne(
      { subject: userId, objectType: "project", object: projectId },
      { $set: { relation }, $setOnInsert: { createdBy: user._id } },
      { upsert: true }
    );
  } catch (e) {
    // Two concurrent grants of the same pair race the unique index; the row exists either way
    if ((e as { code?: number }).code !== 11000) throw e;
  }

  return NextResponse.json({ ok: true });
});

export const DELETE = withProjectOwner(async (request, { params }) => {
  const { projectId } = await params;
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  await connectDB();
  if ((await ownerCount(projectId)) <= 1) {
    const remaining = await Grant.find({ objectType: "project", object: projectId })
      .select("subject relation")
      .lean();
    const isLastOwner = remaining.some(
      (g) => String(g.subject) === userId && g.relation === "owner"
    );
    if (isLastOwner) {
      return NextResponse.json(
        { error: "A board must keep at least one owner" },
        { status: 409 }
      );
    }
  }

  await Grant.deleteOne({ subject: userId, objectType: "project", object: projectId });

  return NextResponse.json({ ok: true });
});
