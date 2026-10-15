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

// One pass over each collection for the whole set, not one per file: neither has an index to search these fields by
async function namedElsewhere(db: ScopedDb, ids: string[]): Promise<Set<string>> {
  const pattern = `/api/uploads/(${ids.join("|")})`;
  const matching = { $regex: pattern, $options: "i" };
  const [tasks, comments, messages] = await Promise.all([
    db.Task.find({ $or: [{ description: matching }, { "checklist.text": matching }] })
      .select("description checklist.text")
      .lean(),
    db.Comment.find({ body: matching }).select("body").lean(),
    db.PmMessage.find({ $or: [{ "attachments.fileId": { $in: ids } }, { content: matching }] })
      .select("attachments content")
      .lean(),
  ]);
  return new Set([
    ...uploadIdsIn(
      ...tasks.flatMap((task) => [task.description, ...(task.checklist ?? []).map((item: { text: string }) => item.text)]),
      ...comments.map((comment) => comment.body),
      ...messages.map((message) => message.content)
    ),
    ...messages.flatMap((message) => (message.attachments ?? []).map((attachment: { fileId: string }) => attachment.fileId.toLowerCase())),
  ]);
}

/**
 * Called after the row that quoted these files is gone: each one this board holds is removed unless
 * something else in the organisation still names it. Never throws, so a delete is not undone by it.
 */
export async function releaseUploads(db: ScopedDb, project: string, ids: string[]): Promise<void> {
  const uploads = organisationUploads(db);
  if (!uploads || ids.length === 0) return;
  try {
    const wanted = ids.slice(0, MOST_FILES_PER_DELETE);
    const held = await uploads.ofProject(wanted.map((id) => new mongoose.Types.ObjectId(id)), project);
    if (held.length === 0) return;
    const kept = await namedElsewhere(db, held.map((file) => String(file._id)));
    for (const file of held) {
      if (kept.has(String(file._id))) continue;
      try {
        await uploads.discard(file._id);
      } catch (error) {
        console.error(`Uploaded file ${file._id} of board ${project} could not be released: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    console.error(`Uploaded files of a deleted row on board ${project} could not be released: ${error instanceof Error ? error.message : error}`);
  }
}

export async function releaseProjectUploads(db: ScopedDb, project: string): Promise<void> {
  try {
    await organisationUploads(db)?.discardProject(project);
  } catch (error) {
    console.error(`Uploaded files of a deleted board could not be released: ${error instanceof Error ? error.message : error}`);
  }
}
