import mongoose from "mongoose";
import { connectDB } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<Record<string, string>> }
) {
  await connectDB();
  const { fileId } = await params;

  let objectId: mongoose.Types.ObjectId;
  try {
    objectId = new mongoose.Types.ObjectId(fileId);
  } catch {
    return new Response("Invalid file ID", { status: 400 });
  }

  const db = mongoose.connection.db;
  if (!db) {
    return new Response("Database not connected", { status: 500 });
  }

  const bucket = new mongoose.mongo.GridFSBucket(db, {
    bucketName: "uploads",
  });

  // Check file exists
  const files = await bucket.find({ _id: objectId }).toArray();
  if (files.length === 0) {
    return new Response("File not found", { status: 404 });
  }

  const file = files[0];
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
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
