import mongoose from "mongoose";
import { dbName, resolveUri } from "./mongo-uri";
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
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { dbName: dbName() });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");

  console.log(`connected via ${source}${DRY_RUN ? " (dry run)" : ""}`);

  const files = await db.collection("uploads.files").find({}).toArray();
  const unstamped = files.filter((f) => !f.metadata?.project);

  console.log(`${files.length} uploads, ${unstamped.length} without a project`);

  let stamped = 0;
  const orphans: string[] = [];
  const ambiguous: string[] = [];

  const describe = (f: (typeof files)[number]) => {
    const kb = (Number(f.length) / 1024).toFixed(1);
    const when = new Date(f.uploadDate).toISOString().slice(0, 10);
    return `${f.filename} · ${f.metadata?.contentType ?? "?"} · ${kb} KB · ${when}`;
  };

  for (const file of unstamped) {
    const id = String(file._id);
    const projects = await projectsReferencing(id);

    if (projects.size === 0) {
      orphans.push(`${id}  ${describe(file)}`);
      continue;
    }
    if (projects.size > 1) {
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
  console.log(
    `unreferenced (nothing links to them, so they have no owner to check and will 404): ${orphans.length}`
  );
  orphans.forEach((id) => console.log(`  ${id}`));
  console.log(`ambiguous (resolve by hand): ${ambiguous.length}`);
  ambiguous.forEach((line) => console.log(`  ${line}`));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
