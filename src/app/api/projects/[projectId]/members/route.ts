import { NextResponse } from "next/server";
import { Types, isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { audienceFilterFrom, recipientsWithAccess } from "@/lib/grants";
import { User } from "@/models/user";
import { Grant } from "@/models/grant";
import { Notification } from "@/models/notification";
import { GRANT_RELATIONS, GrantRelation } from "@/types";

async function ownerCount(projectId: string): Promise<number> {
  return Grant.countDocuments({ objectType: "project", object: projectId, relation: "owner" });
}

export const GET = withProjectOwner(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const grants = await Grant.find({ objectType: "project", object: projectId })
    .select("subject relation")
    .lean();

  const users = await User.find({
    ...audienceFilterFrom(grants.map((g) => g.subject)),
    kind: { $ne: "machine" },
  })
    .select("username fullName role")
    .sort({ username: 1 })
    .lean();

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

  if (typeof userId !== "string" || !isValidObjectId(userId) || !relation || !GRANT_RELATIONS.includes(relation)) {
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
  if (!isValidObjectId(userId)) {
    return NextResponse.json({ error: "userId must be an object id" }, { status: 400 });
  }
  const subject = new Types.ObjectId(userId).toString();

  await connectDB();
  if ((await ownerCount(projectId)) <= 1) {
    const remaining = await Grant.find({ objectType: "project", object: projectId })
      .select("subject relation")
      .lean();
    const isLastOwner = remaining.some(
      (g) => String(g.subject) === subject && g.relation === "owner"
    );
    if (isLastOwner) {
      return NextResponse.json(
        { error: "A board must keep at least one owner" },
        { status: 409 }
      );
    }
  }

  await Grant.deleteOne({ subject, objectType: "project", object: projectId });

  let stillReaches = true;
  try {
    stillReaches = (await recipientsWithAccess([subject], projectId)).length > 0;
  } catch (err) {
    console.error("Could not tell whether the removed member still reaches the board:", err);
  }

  if (!stillReaches) {
    try {
      await Notification.deleteMany({ recipient: subject, project: projectId });
    } catch (err) {
      console.error("Failed to clear notifications for a removed member:", err);
    }
  }

  return NextResponse.json({ ok: true });
});
