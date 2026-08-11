import mongoose from "mongoose";
import { Comment } from "@/models/comment";
import { PmMessage } from "@/models/pmMessage";
import { Task } from "@/models/task";

export const UPLOAD_BUCKET = "uploads";

export function uploadsBucket(): mongoose.mongo.GridFSBucket | null {
  const db = mongoose.connection.db;
  return db ? new mongoose.mongo.GridFSBucket(db, { bucketName: UPLOAD_BUCKET }) : null;
}

// Files predate any notion of ownership, so their project has to be recovered from whatever embeds
// them. Every reference is written as /api/uploads/<id> into markdown, except PM attachments which
// carry the id in a field.
async function resolveLegacyProject(fileId: string): Promise<string | null> {
  const reference = `/api/uploads/${fileId}`;

  const pmMessage = await PmMessage.findOne({ "attachments.fileId": fileId })
    .select("project")
    .lean();
  if (pmMessage?.project) return String(pmMessage.project);

  const comment = await Comment.findOne({ body: { $regex: reference, $options: "i" } })
    .select("task")
    .lean();
  if (comment?.task) {
    const task = await Task.findById(comment.task).select("project").lean();
    if (task?.project) return String(task.project);
  }

  const task = await Task.findOne({
    $or: [
      { description: { $regex: reference, $options: "i" } },
      { "checklist.text": { $regex: reference, $options: "i" } },
    ],
  })
    .select("project")
    .lean();
  if (task?.project) return String(task.project);

  return null;
}

/**
 * The project a file belongs to, or null when nothing references it. Recovering a legacy file's
 * project is written back so the search happens once per file rather than once per request.
 */
export async function projectForUpload(
  file: { _id: mongoose.Types.ObjectId; metadata?: Record<string, unknown> | null },
  fileId: string
): Promise<string | null> {
  const stored = file.metadata?.project;
  if (stored) return String(stored);

  const resolved = await resolveLegacyProject(fileId);
  if (!resolved) return null;

  const db = mongoose.connection.db;
  if (db) {
    await db
      .collection(`${UPLOAD_BUCKET}.files`)
      .updateOne({ _id: file._id }, { $set: { "metadata.project": resolved } })
      .catch(() => {});
  }

  return resolved;
}
