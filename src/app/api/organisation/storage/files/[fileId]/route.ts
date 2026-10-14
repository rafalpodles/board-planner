import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAdmin } from "@/lib/middleware";
import { formatStorage } from "@/lib/storage-size";
import { organisationUploads } from "@/lib/upload-ownership";

export const DELETE = withAdmin(async (_request, { params, user, db }) => {
  // The one thing on this route that cannot be undone, so a token that sits on a worker's disk does not reach it
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }
  const { fileId } = await params;
  if (!mongoose.isObjectIdOrHexString(fileId)) return NextResponse.json({ error: "Invalid file id" }, { status: 400 });
  await connectDB();

  const uploads = organisationUploads(db);
  if (!uploads) return NextResponse.json({ error: "Database not connected" }, { status: 500 });
  const file = await uploads.discard(new mongoose.Types.ObjectId(fileId));
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });

  const board = file.metadata?.project ? await db.Project.findById(String(file.metadata.project), "key").lean() : null;
  void logInstanceAudit(db, {
    action: "upload_deleted",
    user: user._id,
    actorUsername: user.username,
    // File names repeat, and the audit model has no length limit
    target: file.filename.slice(0, 200),
    detail: [formatStorage(file.length), board?.key ?? "no board", String(file._id)].join(" · "),
  });
  return NextResponse.json({ freedBytes: file.length });
});
