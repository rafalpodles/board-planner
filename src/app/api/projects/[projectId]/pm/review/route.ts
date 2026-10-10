import { after, NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { isPmRunnable, pmDisabledReason } from "@/lib/pm/gate";
import { openGate, refuseUnmanagedModel } from "@/lib/ai-gateway";
import { resolvePmModel } from "@/lib/pm/availability";
import { getPmUser } from "@/lib/pm/pm-user";
import { startBoardReview } from "@/lib/pm/scheduler";

// A review is a full PM turn, which the chat route allows the same ceiling
export const maxDuration = 300;

/**
 * Runs the board review now, on the same path the schedule uses: the AI allowance, the turn lock, the
 * digest and the tools it withholds. It does not claim the scheduled slot, so the next scheduled
 * review still happens. An owner switching the review on otherwise waited for the clock to learn
 * what it would say (BP-471).
 */
export const POST = withProjectOwner(async (_request, { params, user, db }) => {
  // It spends the project's turn and token budget, which a person should decide to do
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 });
  }
  // Without a model key a review would still take a turn and post a warning to the
  // thread; the chat route refuses the same way for the same reason
  const gate = await openGate(db, { error: "The PM agent is not configured on this instance", status: 503 });
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });
  const { projectId } = await params;
  await connectDB();

  const project = await db.Project.findById(projectId, "key pm").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!isPmRunnable(project.pm)) {
    return NextResponse.json({ error: pmDisabledReason(project.pm) }, { status: 409 });
  }
  const unmanaged = refuseUnmanagedModel(gate, await resolvePmModel(db, project.pm.model));
  if (unmanaged) return NextResponse.json(unmanaged.body, { status: unmanaged.status });

  const pmUser = await getPmUser(db);
  const review = await startBoardReview(db, String(project._id), project.key, project.pm, String(pmUser._id));
  if (review.status === "skipped") {
    return NextResponse.json({ error: `The review cannot run: ${review.reason}.` }, { status: 409 });
  }
  after(() => review.done);
  return NextResponse.json({ started: true }, { status: 202 });
});
