import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { mayDecide, recordVerdict, toApiDecision, Verdict } from "@/lib/task-decisions";
import { Task } from "@/models/task";
import { Worker } from "@/models/worker";
import { InstanceAuditAction } from "@/types";

const VERDICTS: Verdict[] = ["accept", "decline", "abandon"];

const AUDIT: Record<Verdict, InstanceAuditAction> = {
  accept: "worker_decision_accepted",
  decline: "worker_decision_declined",
  abandon: "worker_decision_abandoned",
};

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  // Same rule as `force`, and heavier: this runs an agent's change under the machine owner's
  // pinned GitHub identity. An unattended agent must not do that on a person's behalf, and the PM
  // agent is deliberately given no way to name this route at all.
  if (user.viaMachineCredential) {
    return NextResponse.json(
      { error: "answering a refused change needs an interactive session" },
      { status: 403 }
    );
  }

  const body = await readJsonBody<{ verdict?: unknown }>(request);
  if (!body.ok) return body.response;

  const verdict = body.value.verdict;
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict as Verdict)) {
    return NextResponse.json(
      { error: `verdict must be one of ${VERDICTS.join(", ")}` },
      { status: 400 }
    );
  }

  await connectDB();
  const task = await Task.findOne({ _id: taskId, project: projectId }).select(
    "taskNumber decision"
  );
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const decision = task.decision;
  if (!decision?.gate) {
    return NextResponse.json({ error: "nothing is waiting on a decision here" }, { status: 404 });
  }

  if (!(await mayDecide(decision.workerId, user))) {
    return NextResponse.json(
      {
        error:
          "only the machine holding this work — its owner — or an instance admin can answer a refused change",
      },
      { status: 403 }
    );
  }

  // Read off the record rather than the request: a record the gate marked unacceptable carries a
  // workflow file or a patch that was cut, and neither becomes acceptable because somebody posted
  // the word "accept".
  if (verdict === "accept" && !decision.acceptable) {
    return NextResponse.json(
      { error: decision.unacceptableReason || "this change cannot be accepted" },
      { status: 409 }
    );
  }

  // Pinned to the record this request read and judged — see DecisionPin.
  const result = await recordVerdict(taskId, verdict as Verdict, String(user._id), {
    workerId: decision.workerId,
    commit: decision.commit,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const worker = await Worker.findById(decision.workerId)
    .select("name lastSeenAt")
    .lean<{ name?: string; lastSeenAt?: Date | null } | null>();

  void logInstanceAudit({
    action: AUDIT[verdict as Verdict],
    // The machine, because that is what the entry is about: what was spent is its owner's pinned
    // GitHub identity. The task and the commit are in the detail.
    target: worker?.name || decision.workerId,
    user: String(user._id),
    actorUsername: user.username,
    detail: `${decision.taskKey || `task ${task.taskNumber}`} at ${decision.commit.slice(0, 12)} — ${
      decision.gate
    } gate, ${decision.files.length} file(s)`,
  });

  return NextResponse.json({ decision: toApiDecision(result.decision, worker, true) });
});
