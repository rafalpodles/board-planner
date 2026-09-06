import mongoose from "mongoose";

export const UPLOAD_BUCKET = "uploads";

export function uploadsBucket(): mongoose.mongo.GridFSBucket | null {
  const db = mongoose.connection.db;
  return db ? new mongoose.mongo.GridFSBucket(db, { bucketName: UPLOAD_BUCKET }) : null;
}

export function projectForUpload(file: {
  metadata?: Record<string, unknown> | null;
}): string | null {
  const stored = file.metadata?.project;
  return stored ? String(stored) : null;
}
