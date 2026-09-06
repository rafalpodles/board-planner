import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { projectForUpload, uploadsBucket } from "@/lib/upload-ownership";

const INLINE_SAFE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const GET = withAuth(async (_request, { params, user }) => {
  const { fileId } = await params;
  await connectDB();

  let objectId: mongoose.Types.ObjectId;
  try {
    objectId = new mongoose.Types.ObjectId(fileId);
  } catch {
    return new Response("Invalid file ID", { status: 400 });
  }

  const bucket = uploadsBucket();
  if (!bucket) {
    return new Response("Database not connected", { status: 500 });
  }

  const files = await bucket.find({ _id: objectId }).toArray();
  if (files.length === 0) {
    return new Response("File not found", { status: 404 });
  }

  const file = files[0];

  const project = projectForUpload(file);
  if (!project) {
    return new Response("File not found", { status: 404 });
  }
  if (!(await check(user, project, "access"))) {
    return new Response("File not found", { status: 404 });
  }

  const contentType =
    (file.metadata?.contentType as string) || "application/octet-stream";

  const chunks: Buffer[] = [];
  const downloadStream = bucket.openDownloadStream(objectId);

  await new Promise<void>((resolve, reject) => {
    downloadStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    downloadStream.on("end", resolve);
    downloadStream.on("error", reject);
  });

  const buffer = Buffer.concat(chunks);

  return new Response(buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": buffer.length.toString(),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": INLINE_SAFE_TYPES.has(contentType) ? "inline" : "attachment",
    },
  });
});
