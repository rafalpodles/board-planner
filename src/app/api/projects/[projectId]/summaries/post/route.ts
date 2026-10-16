import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { requireEntitlement, withProjectAccess } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { decryptSecret } from "@/lib/encryption";
import { countAttempt, sourceKey } from "@/lib/rate-limit";
import { postToTeamChannels } from "@/lib/notifications";
import { escapeDiscord } from "@/lib/chat-markup";
import { summaryMarkdown } from "@/ee/ai/summaries";
import type { SealedSummary } from "../route";

// A summary is posted within the hour it was written, once, or written again
export const SEALED_SUMMARY_MS = 60 * 60 * 1000;
export const POSTS_PER_USER_WINDOW = 10;

const NOT_OURS = "That is not a summary this board wrote";

export const POST = withProjectAccess(
  requireEntitlement("ai.digest", async (request, { params, user, db }) => {
    const { projectId } = await params;
    const read = await readJsonBody<{ sealed?: unknown }>(request);
    if (!read.ok) return read.response;
    let summary: Partial<SealedSummary>;
    try {
      summary = JSON.parse(decryptSecret(String(read.value.sealed ?? ""), db.organisation));
    } catch {
      return NextResponse.json({ error: NOT_OURS }, { status: 400 });
    }
    if (summary.purpose !== "summary" || summary.projectId !== projectId || !summary.facts || typeof summary.at !== "number" || typeof summary.nonce !== "string") {
      return NextResponse.json({ error: NOT_OURS }, { status: 400 });
    }
    if (Date.now() - summary.at >= SEALED_SUMMARY_MS) {
      return NextResponse.json({ error: "That summary is an hour old or more; write it again" }, { status: 410 });
    }
    if ((await countAttempt(sourceKey(`user:${String(user._id)}`, "ai-summary-post"))) > POSTS_PER_USER_WINDOW) {
      return NextResponse.json({ error: "Too many summaries posted. Try again in 15 minutes." }, { status: 429 });
    }
    if ((await countAttempt(sourceKey(`summary:${summary.nonce}`, "ai-summary-posted"), SEALED_SUMMARY_MS)) > 1) {
      return NextResponse.json({ error: "That summary has been posted already" }, { status: 409 });
    }
    await connectDB();
    const note = typeof summary.note === "string" ? summary.note : null;
    const result = await postToTeamChannels(db, projectId, {
      slack: summaryMarkdown(note, summary.facts),
      // Discord renders a masked link written into a title; what the board's people wrote is escaped
      discord: summaryMarkdown(note, summary.facts, escapeDiscord),
    });
    if (result.channels === 0) return NextResponse.json({ error: "This project has no team channel" }, { status: 409 });
    return NextResponse.json(result);
  })
);
