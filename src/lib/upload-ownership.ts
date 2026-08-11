import mongoose from "mongoose";

export const UPLOAD_BUCKET = "uploads";

export function uploadsBucket(): mongoose.mongo.GridFSBucket | null {
  const db = mongoose.connection.db;
  return db ? new mongoose.mongo.GridFSBucket(db, { bucketName: UPLOAD_BUCKET }) : null;
}

/**
 * The project a file belongs to, from what was recorded when it was uploaded. A file with nothing
 * recorded cannot be read.
 *
 * An earlier version recovered the project on demand by searching whatever embedded the file. That
 * was poisonable: the search ran newest-source-first, so an attacker could claim a file they knew
 * the id of simply by referencing it from their own board at a higher-priority source than the one
 * it really lived in — and the answer was written back before the access check ran, so a single
 * probe retargeted the file permanently and locked its real owners out. Stamping legacy files is a
 * migration (scripts/migrate-upload-projects.ts), not a request path.
 */
export function projectForUpload(file: {
  metadata?: Record<string, unknown> | null;
}): string | null {
  const stored = file.metadata?.project;
  return stored ? String(stored) : null;
}
