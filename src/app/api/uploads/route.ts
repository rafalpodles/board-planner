import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { Readable } from "stream";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const POST = withAuth(async (request) => {
  await connectDB();

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `File type "${file.type}" is not allowed.` },
      { status: 400 }
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "File too large. Maximum size is 5MB." },
      { status: 413 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const db = mongoose.connection.db;
  if (!db) {
    return NextResponse.json(
      { error: "Database not connected" },
      { status: 500 }
    );
  }

  const bucket = new mongoose.mongo.GridFSBucket(db, {
    bucketName: "uploads",
  });

  const uploadStream = bucket.openUploadStream(file.name, {
    metadata: {
      contentType: file.type,
      originalName: file.name,
      size: file.size,
    },
  });

  await new Promise<void>((resolve, reject) => {
    const readable = Readable.from(buffer);
    readable.pipe(uploadStream);
    uploadStream.on("finish", resolve);
    uploadStream.on("error", reject);
  });

  const fileId = uploadStream.id.toString();
  const isImage = file.type.startsWith("image/");

  return NextResponse.json({
    fileId,
    fileName: file.name,
    contentType: file.type,
    size: file.size,
    url: `/api/uploads/${fileId}`,
    markdown: isImage
      ? `![${file.name}](/api/uploads/${fileId})`
      : `[${file.name}](/api/uploads/${fileId})`,
  });
});
