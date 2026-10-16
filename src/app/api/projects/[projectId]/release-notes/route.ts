import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { requireEntitlement, withProjectAccess } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { countAttempt, sourceKey } from "@/lib/rate-limit";
import { RELEASE_NOTE_TONES, isEmpty, releaseMaterial, writeReleaseNotes, type ReleaseNoteTone, type ReleaseWindow } from "@/ee/ai/release-notes";

/** Notes one person may ask for in the rate limiter's 15-minute window */
export const NOTES_PER_USER_WINDOW = 20;
const MAX_DAYS = 366;
// One at a time per person: each asks the repository for up to five pages
const inFlight = new Set<string>();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(value: unknown, end: boolean): Date | null {
  if (typeof value !== "string" || !DAY.test(value)) return null;
  const at = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? null : at;
}

export const POST = withProjectAccess(
  requireEntitlement("ai.release_notes", async (request, { params, user, db }) => {
    const { projectId } = await params;
    const read = await readJsonBody<{ sprintId?: unknown; from?: unknown; to?: unknown; tone?: unknown }>(request);
    if (!read.ok) return read.response;
    const { sprintId, from, to, tone = "changelog" } = read.value;
    if (!RELEASE_NOTE_TONES.includes(tone as ReleaseNoteTone)) {
      return NextResponse.json({ error: `tone must be one of: ${RELEASE_NOTE_TONES.join(", ")}` }, { status: 400 });
    }
    await connectDB();

    let window: ReleaseWindow;
    if (sprintId !== undefined) {
      if (typeof sprintId !== "string" || !isValidObjectId(sprintId)) return NextResponse.json({ error: "sprintId must be a sprint's id" }, { status: 400 });
      const sprint = await db.Sprint.findOne({ _id: sprintId, project: projectId }, "name startDate endDate").lean<{ name: string; startDate: Date; endDate: Date }>();
      if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
      // A sprint ends where the next one may begin, so its last instant is just before its end date
      window = { from: new Date(sprint.startDate), to: new Date(new Date(sprint.endDate).getTime() - 1), label: sprint.name, sprintId: String(sprintId) };
    } else {
      const start = day(from, false);
      const end = day(to, true);
      if (!start || !end) return NextResponse.json({ error: "Name a sprint, or a from and a to day, YYYY-MM-DD" }, { status: 400 });
      if (start > end) return NextResponse.json({ error: "from must not be after to" }, { status: 400 });
      if (end.getTime() - start.getTime() > MAX_DAYS * 86_400_000) {
        return NextResponse.json({ error: `A window may span at most ${MAX_DAYS} days` }, { status: 400 });
      }
      window = { from: start, to: end, label: `${from} to ${to}` };
    }

    // Counted before any work, empty answers included: the repository is read for every one of them
    const holder = String(user._id);
    if ((await countAttempt(sourceKey(`user:${holder}`, "ai-release-notes"))) > NOTES_PER_USER_WINDOW) {
      return NextResponse.json({ error: "Too many release notes asked for. Try again in 15 minutes." }, { status: 429 });
    }
    if (inFlight.has(holder)) return NextResponse.json({ error: "Release notes are already being written." }, { status: 409 });
    inFlight.add(holder);
    try {
      const material = await releaseMaterial(db, projectId, window);
      if (!material) return NextResponse.json({ error: "Project not found" }, { status: 404 });
      const counts = {
        tasks: material.tasks.length,
        pullRequests: material.pullRequestsWithoutTask.length,
        tasksLeftOut: material.tasksLeftOut,
        pullRequestsIncomplete: material.pullRequestsIncomplete,
        repositoryUnread: material.repositoryUnread,
      };
      // Nothing shipped is said plainly, and costs no model call
      if (isEmpty(material)) {
        return NextResponse.json({ markdown: `Nothing reached a done column, and no pull request was merged, in ${window.label}.`, empty: true, ...counts });
      }
      const written = await writeReleaseNotes(db, { projectId, userId: holder }, material, tone as ReleaseNoteTone);
      if (!written.ok) return NextResponse.json(written.body, { status: written.status });
      return NextResponse.json({ markdown: written.text, empty: false, ...counts });
    } finally {
      inFlight.delete(holder);
    }
  })
);
