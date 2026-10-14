import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAdmin } from "@/lib/middleware";
import { formatStorage } from "@/lib/storage-size";
import { organisationUploads } from "@/lib/upload-ownership";

export const DELETE = withAdmin(async (_request, { params, user, db }) => {
  const { fileId } = await params;
  if (!mongoose.isValidObjectId(fileId)) return NextResponse.json({ error: "Invalid file id" }, { status: 400 });
  await connectDB();

  const uploads = organisationUploads(db);
  if (!uploads) return NextResponse.json({ error: "Database not connected" }, { status: 500 });
  const file = await uploads.discard(new mongoose.Types.ObjectId(fileId));
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });

  void logInstanceAudit(db, {
    action: "upload_deleted",
    user: user._id,
    actorUsername: user.username,
    target: file.filename,
    detail: formatStorage(file.length),
  });
  return NextResponse.json({ freedBytes: file.length });
});
