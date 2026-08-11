/**
 * BP-294: stamp every existing upload with the project it belongs to.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/migrate-upload-projects.ts --dry-run
 *   MONGODB_URI=... npx tsx scripts/migrate-upload-projects.ts
 *
 * Against production, through the database service — the app service's URI is on Railway's
 * private network and does not resolve from a laptop:
 *   railway run --service MongoDB -- npx tsx scripts/migrate-upload-projects.ts --dry-run
 *
 * Uploads recorded no owner, so the read path had nothing to check and served any file to any
 * authenticated caller. Uploads made from now on carry their project; these are the ones made
 * before, and they are unreadable until stamped.
 *
 * Doing this offline rather than on demand is the point. Resolving an owner per request means
 * searching whatever embeds the file, and that search is attacker-controlled: anyone who knows a
 * file id can reference it from their own board and claim it. Run once, by an operator, against a
 * corpus nobody is editing, the same search is safe — and a file that resolves to more than one
 * project is reported rather than guessed at.
 *
 * Timing. Run it BEFORE the deploy. Files stamped early are still readable under the old code,
 * which checks nothing; files left unstamped after the deploy return 404 to their own owners.
 */
import mongoose from "mongoose";
import { Comment } from "../src/models/comment";
import { PmMessage } from "../src/models/pmMessage";
import { Task } from "../src/models/task";

const DRY_RUN = process.argv.includes("--dry-run");

async function projectsReferencing(fileId: string): Promise<Set<string>> {
  const reference = `/api/uploads/${fileId}`;
  const found = new Set<string>();

  for (const m of await PmMessage.find({ "attachments.fileId": fileId }).select("project").lean()) {
    if (m.project) found.add(String(m.project));
  }

  const comments = await Comment.find({ body: { $regex: reference } }).select("task").lean();
  for (const c of comments) {
    const task = await Task.findById(c.task).select("project").lean();
    if (task?.project) found.add(String(task.project));
  }

  const tasks = await Task.find({
    $or: [{ description: { $regex: reference } }, { "checklist.text": { $regex: reference } }],
  })
    .select("project")
    .lean();
  for (const t of tasks) {
    if (t.project) found.add(String(t.project));
  }

  return found;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no database handle");

  const files = await db.collection("uploads.files").find({}).toArray();
  const unstamped = files.filter((f) => !f.metadata?.project);

  console.log(`${files.length} uploads, ${unstamped.length} without a project`);

  let stamped = 0;
  const orphans: string[] = [];
  const ambiguous: string[] = [];

  for (const file of unstamped) {
    const id = String(file._id);
    const projects = await projectsReferencing(id);

    if (projects.size === 0) {
      orphans.push(id);
      continue;
    }
    if (projects.size > 1) {
      // Guessing here is what the request-path version did, and it is how a file gets taken
      ambiguous.push(`${id} -> ${[...projects].join(", ")}`);
      continue;
    }

    const [project] = [...projects];
    if (!DRY_RUN) {
      await db
        .collection("uploads.files")
        .updateOne({ _id: file._id }, { $set: { "metadata.project": project } });
    }
    stamped++;
  }

  console.log(`${DRY_RUN ? "would stamp" : "stamped"}: ${stamped}`);
  console.log(`unreferenced (will 404, nothing links to them): ${orphans.length}`);
  orphans.forEach((id) => console.log(`  ${id}`));
  console.log(`ambiguous (resolve by hand): ${ambiguous.length}`);
  ambiguous.forEach((line) => console.log(`  ${line}`));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
