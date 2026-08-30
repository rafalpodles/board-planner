import { NextResponse } from "next/server";
import { readFormBody } from "@/lib/request-body";
import mongoose from "mongoose";
import { Readable } from "stream";
import { connectDB } from "@/lib/db";
import { withAuth, resolveProjectId } from "@/lib/middleware";
import { check } from "@/lib/grants";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
// The whole multipart envelope, not the file: part headers, the boundary and the projectId field
// come to a few hundred bytes, so the slack is generous rather than tuned. Its job is to bound
// what the process allocates, which the file-size check below cannot do — that one runs after
// formData() has already materialised every part.
const MAX_UPLOAD_REQUEST_BYTES = MAX_FILE_SIZE + 64 * 1024;

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

export const POST = withAuth(async (request, { user }) => {
  await connectDB();

  // Counted through, not just declared. The file.size check further down cannot be the bound:
  // it runs twenty-nine lines and several round trips after the body has been materialised, so
  // the 5 MB limit governs what reaches GridFS rather than what the process allocates — and a
  // request that simply omits Content-Length walked past a header check on its own.
  const read = await readFormBody(request, MAX_UPLOAD_REQUEST_BYTES);
  if (!read.ok) return read.response;
  const formData = read.value;
  const file = formData.get("file") as File | null;
  const projectId = String(formData.get("projectId") || "");

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Recorded so the read side has an owner to check. Without it a file id is a bearer token for
  // anyone who guesses it.
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  // Callers hold a project key; grants are keyed on the id
  const project = await resolveProjectId(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (!(await check(user, project, "access"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      project: project,
      uploadedBy: String(user._id),
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
