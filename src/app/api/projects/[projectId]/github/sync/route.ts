import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { syncGithubPullRequests } from "@/lib/github-sync";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";

// The library already keeps GitHub's own body out of the message (see `refusal`); this is the
// last cap before it reaches a toast.
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : "no answer";
  return message.split("\n")[0].slice(0, 200);
}

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  // Optional, and the task detail's Refresh is the only caller that sends it: the sync still reads
  // every pull request, but only the named task may be moved out of review by it.
  const body = await request.json().catch(() => ({}));
  const transitionOnly =
    typeof body?.taskNumber === "number" && Number.isInteger(body.taskNumber)
      ? body.taskNumber
      : undefined;

  const project = await Project.findById(projectId).lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The person asking is what earns the auto-transition: a background tick passes null and moves
  // nothing, because a column change with an invented author is a history row nobody can explain.
  // Caught here rather than left to escape. `fetchPullRequests` throws on every non-ok answer from
  // GitHub — a wrong token, a rate limit, a renamed repository, a timeout — and an uncaught throw
  // is a 500 whose body is not JSON. The client then falls back to `res.statusText`, which under
  // HTTP/2 is empty by definition: on Railway that is a red toast with no words in it.
  let result: Awaited<ReturnType<typeof syncGithubPullRequests>>;
  try {
    result = await syncGithubPullRequests(project, String(user._id), transitionOnly);
  } catch (err) {
    console.error("GitHub sync failed:", err);
    return NextResponse.json(
      { error: `GitHub could not be reached: ${firstLine(err)}` },
      { status: 502 }
    );
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const { ok: _ok, ...counts } = result;
  return NextResponse.json({ synced: true, ...counts });
});
