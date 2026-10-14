import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/middleware";
import { organisationUploads } from "@/lib/upload-ownership";

const LISTED = 25;

const ids = (values: unknown[]) =>
  [...new Set(values.map(String))].filter((value) => mongoose.isValidObjectId(value)).map((value) => new mongoose.Types.ObjectId(value));

export const GET = withAdmin(async (_request, { db }) => {
  const uploads = organisationUploads(db);
  if (!uploads) return NextResponse.json({ error: "Database not connected" }, { status: 500 });

  const [files, total] = await Promise.all([uploads.largest(LISTED), uploads.count()]);
  const [projects, people] = await Promise.all([
    db.Project.find({ _id: { $in: ids(files.map((file) => file.metadata?.project)) } }, "key name").lean(),
    db.User.find({ _id: { $in: ids(files.map((file) => file.metadata?.uploadedBy)) } }, "username").lean(),
  ]);
  const board = new Map(projects.map((project) => [String(project._id), { key: project.key as string, name: project.name as string }]));
  const name = new Map(people.map((person) => [String(person._id), person.username as string]));

  return NextResponse.json({
    total,
    files: files.map((file) => ({
      id: String(file._id),
      name: file.filename,
      size: file.length,
      contentType: (file.metadata?.contentType as string | undefined) || null,
      uploadedAt: file.uploadDate,
      project: board.get(String(file.metadata?.project)) ?? null,
      uploadedBy: name.get(String(file.metadata?.uploadedBy)) ?? null,
    })),
  });
});
