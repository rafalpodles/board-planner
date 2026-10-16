import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { requireEntitlement, withProjectAccess } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { decryptSecret } from "@/lib/encryption";
import { postToTeamChannels } from "@/lib/notifications";

// A summary is posted within the hour it was written, or written again
export const SEALED_SUMMARY_MS = 60 * 60 * 1000;

export const POST = withProjectAccess(
  requireEntitlement("ai.digest", async (request, { params, db }) => {
    const { projectId } = await params;
    const read = await readJsonBody<{ sealed?: unknown }>(request);
    if (!read.ok) return read.response;
    let summary: { projectId?: unknown; markdown?: unknown; at?: unknown };
    try {
      summary = JSON.parse(decryptSecret(String(read.value.sealed ?? ""), db.organisation));
    } catch {
      return NextResponse.json({ error: "That is not a summary this board wrote" }, { status: 400 });
    }
    if (summary.projectId !== projectId || typeof summary.markdown !== "string" || typeof summary.at !== "number") {
      return NextResponse.json({ error: "That is not a summary this board wrote" }, { status: 400 });
    }
    if (Date.now() - summary.at > SEALED_SUMMARY_MS) {
      return NextResponse.json({ error: "That summary is over an hour old; write it again" }, { status: 410 });
    }
    await connectDB();
    const result = await postToTeamChannels(db, projectId, summary.markdown);
    if (result.channels === 0) return NextResponse.json({ error: "This project has no team channel" }, { status: 409 });
    return NextResponse.json(result);
  })
);
