import { after, NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { isPmRunnable, pmDisabledReason } from "@/lib/pm/gate";
import { getPmUser } from "@/lib/pm/pm-user";
import { startBoardReview } from "@/lib/pm/scheduler";

// A review is a full PM turn, which the chat route allows the same ceiling
export const maxDuration = 300;

/**
 * Runs the board review now, on the same path the schedule uses: the caps, the turn lock, the
 * digest and the tools it withholds. It does not claim the scheduled slot, so the next scheduled
 * review still happens. An owner switching the review on otherwise waited for the clock to learn
 * what it would say (BP-471).
 */
export const POST = withProjectOwner(async (_request, { params, user }) => {
  // It spends the project's turn and token budget, which a person should decide to do
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 });
  }
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "key pm").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!isPmRunnable(project.pm)) {
    return NextResponse.json({ error: pmDisabledReason(project.pm) }, { status: 409 });
  }

  const pmUser = await getPmUser();
  const review = await startBoardReview(String(project._id), project.key, project.pm, String(pmUser._id));
  if (review.status === "skipped") {
    return NextResponse.json({ error: `The review cannot run: ${review.reason}.` }, { status: 409 });
  }
  after(() => review.done);
  return NextResponse.json({ started: true }, { status: 202 });
});
