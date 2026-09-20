import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";

// The sidebar order is one list shared by everyone, so it is an instance-level
// setting — the same reason creating a project is admin-only.
export const PUT = withAdmin(async (request) => {
  await connectDB();

  const body = await request.json();
  const ids: unknown = body?.order;

  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json(
      { error: "order must be an array of project ids" },
      { status: 400 }
    );
  }

  // Checked before it reaches Mongoose, as the task reorder already does: a malformed id there
  // is a CastError, which surfaces as a 500 rather than the 400 this is.
  if ((ids as string[]).some((id) => !isValidObjectId(id))) {
    return NextResponse.json({ error: "order contains a malformed project id" }, { status: 400 });
  }

  const unique = new Set(ids as string[]);
  if (unique.size !== ids.length) {
    return NextResponse.json({ error: "order contains duplicate ids" }, { status: 400 });
  }

  const known = await Project.find({ _id: { $in: ids } }).select("_id").lean();
  if (known.length !== ids.length) {
    return NextResponse.json({ error: "order contains unknown project ids" }, { status: 400 });
  }

  await Project.bulkWrite(
    (ids as string[]).map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index } } },
    }))
  );

  return NextResponse.json({ updated: ids.length });
});
