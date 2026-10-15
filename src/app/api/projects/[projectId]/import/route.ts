import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { MAX_IMPORT_BYTES, parseBundle, parseMapping } from "@/lib/import/bundle";
import { runImport } from "@/lib/import/engine";

// Quiet by design — nobody is told about what it writes — so it takes an owner at a browser, never a token
export const POST = withProjectOwner(async (request, { params, user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }
  const read = await readJsonBody<{ bundle?: unknown; mapping?: unknown; dryRun?: unknown }>(request, MAX_IMPORT_BYTES);
  if (!read.ok) return read.response;
  const bundle = parseBundle(read.value.bundle);
  if (!bundle.ok) return NextResponse.json({ error: bundle.error }, { status: 400 });
  const mapping = parseMapping(read.value.mapping);
  if (!mapping.ok) return NextResponse.json({ error: mapping.error }, { status: 400 });

  const { projectId } = await params;
  await connectDB();
  const report = await runImport(db, projectId, new Types.ObjectId(String(user._id)), bundle.value, mapping.value, {
    dryRun: read.value.dryRun !== false,
  });
  return NextResponse.json(report);
});
