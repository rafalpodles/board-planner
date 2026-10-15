import mongoose from "mongoose";
import type { ScopedDb } from "./db-scope";
import { organisationUploads } from "./upload-ownership";

const REFERENCE = /\/api\/uploads\/([0-9a-f]{24})/gi;
const MOST_FILES_PER_DELETE = 200;

export function uploadIdsIn(...texts: (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(REFERENCE)) ids.add(match[1].toLowerCase());
  }
  return [...ids];
}

async function stillReferenced(db: ScopedDb, id: string): Promise<boolean> {
  const reference = `/api/uploads/${id}`;
  const [task, comment, message] = await Promise.all([
    db.Task.exists({ $or: [{ description: { $regex: reference } }, { "checklist.text": { $regex: reference } }] }),
    db.Comment.exists({ body: { $regex: reference } }),
    db.PmMessage.exists({ "attachments.fileId": id }),
  ]);
  return Boolean(task || comment || message);
}

/**
 * Called after the row that quoted these files is gone: each one this board holds is removed unless
 * something else in the organisation still names it. Never throws, so a delete is not undone by it.
 */
export async function releaseUploads(db: ScopedDb, project: string, ids: string[]): Promise<void> {
  const uploads = organisationUploads(db);
  if (!uploads || ids.length === 0) return;
  try {
    const wanted = ids.slice(0, MOST_FILES_PER_DELETE).map((id) => new mongoose.Types.ObjectId(id));
    for (const file of await uploads.ofProject(wanted, project)) {
      if (await stillReferenced(db, String(file._id))) continue;
      await uploads.discard(file._id);
    }
  } catch (error) {
    console.error(`Uploaded files of a deleted row could not be released: ${error instanceof Error ? error.message : error}`);
  }
}

export async function releaseProjectUploads(db: ScopedDb, project: string): Promise<void> {
  try {
    await organisationUploads(db)?.discardProject(project);
  } catch (error) {
    console.error(`Uploaded files of a deleted board could not be released: ${error instanceof Error ? error.message : error}`);
  }
}
