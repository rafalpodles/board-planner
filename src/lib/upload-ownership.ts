import mongoose from "mongoose";
import type { ScopedDb } from "./db-scope";

export const UPLOAD_BUCKET = "uploads";

function uploadsBucket(): mongoose.mongo.GridFSBucket | null {
  const db = mongoose.connection.db;
  return db ? new mongoose.mongo.GridFSBucket(db, { bucketName: UPLOAD_BUCKET }) : null;
}

export type UploadedFile = mongoose.mongo.GridFSFile;

// GridFS is the driver's, so no schema declares this: every read and the storage ceiling filter on it
export async function ensureUploadIndexes(): Promise<void> {
  await mongoose.connection.db?.collection(`${UPLOAD_BUCKET}.files`).createIndex({ "metadata.organisation": 1, _id: 1 });
}

/**
 * The bucket as one organisation sees it. GridFS is the driver's, so the organisation wall under
 * the models never sees it: every read here names the organisation in its filter, every file
 * written here carries it, and a file of another organisation is simply not found.
 */
export function organisationUploads(db: ScopedDb) {
  const bucket = uploadsBucket();
  if (!bucket) return null;
  return {
    find: (ids: mongoose.Types.ObjectId[]): Promise<UploadedFile[]> =>
      bucket.find({ _id: { $in: ids }, "metadata.organisation": db.organisation }).toArray(),
    // Only for a file `find` has just returned
    download: (file: UploadedFile) => bucket.openDownloadStream(file._id),
    bytesStored: async (): Promise<number> => {
      const [stored] = await mongoose.connection
        .db!.collection(`${UPLOAD_BUCKET}.files`)
        .aggregate<{ bytes: number }>([
          { $match: { "metadata.organisation": db.organisation } },
          { $group: { _id: null, bytes: { $sum: "$length" } } },
        ])
        .toArray();
      return stored?.bytes ?? 0;
    },
    upload: (name: string, metadata: Record<string, unknown>) =>
      bucket.openUploadStream(name, { metadata: { ...metadata, organisation: db.organisation } }),
  };
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
