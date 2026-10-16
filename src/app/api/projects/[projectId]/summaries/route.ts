import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { requireEntitlement, withProjectAccess } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { countAttempt, sourceKey } from "@/lib/rate-limit";
import { encryptSecret, isEncryptionConfigured } from "@/lib/encryption";
import { SUMMARY_KINDS, summaryFacts, writeSummary, type SummaryKind } from "@/ee/ai/summaries";

/** Summaries one person may ask for in the rate limiter's 15-minute window */
export const SUMMARIES_PER_USER_WINDOW = 20;
const inFlight = new Set<string>();

// What may be posted to the team's channel later: only what this route wrote, sealed so it cannot be swapped
export function sealSummary(projectId: string, markdown: string, organisation: Parameters<typeof encryptSecret>[1]): string {
  return encryptSecret(JSON.stringify({ projectId, markdown, at: Date.now() }), organisation);
}

export const POST = withProjectAccess(
  requireEntitlement("ai.digest", async (request, { params, user, db }) => {
    const { projectId } = await params;
    const read = await readJsonBody<{ kind?: unknown; sprintId?: unknown }>(request);
    if (!read.ok) return read.response;
    const { kind, sprintId } = read.value;
    if (!SUMMARY_KINDS.includes(kind as SummaryKind)) {
      return NextResponse.json({ error: `kind must be one of: ${SUMMARY_KINDS.join(", ")}` }, { status: 400 });
    }
    if (kind === "sprint" && (typeof sprintId !== "string" || !isValidObjectId(sprintId))) {
      return NextResponse.json({ error: "A sprint summary names its sprint" }, { status: 400 });
    }
    await connectDB();

    const holder = String(user._id);
    if ((await countAttempt(sourceKey(`user:${holder}`, "ai-summary"))) > SUMMARIES_PER_USER_WINDOW) {
      return NextResponse.json({ error: "Too many summaries asked for. Try again in 15 minutes." }, { status: 429 });
    }
    if (inFlight.has(holder)) return NextResponse.json({ error: "A summary is already being written." }, { status: 409 });
    inFlight.add(holder);
    try {
      const facts = await summaryFacts(db, projectId, kind as SummaryKind, kind === "sprint" ? (sprintId as string) : null);
      if (!facts) return NextResponse.json({ error: kind === "sprint" ? "Sprint not found" : "Project not found" }, { status: 404 });
      const written = await writeSummary(db, { projectId, userId: holder }, facts);
      if (!written.ok) return NextResponse.json(written.body, { status: written.status });

      const project = await db.Project.findById(projectId, "notificationChannels").lean();
      const channels = (project?.notificationChannels ?? []).filter((c) => c.enabled).length;
      return NextResponse.json({
        markdown: written.markdown,
        noteDropped: written.noteDropped,
        channels,
        sealed: channels > 0 && isEncryptionConfigured() ? sealSummary(projectId, written.markdown, db.organisation) : null,
      });
    } finally {
      inFlight.delete(holder);
    }
  })
);
