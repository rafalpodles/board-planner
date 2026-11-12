import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { originFor } from "@/lib/organisation-host";
import { projectRepositoryUrl } from "@/lib/repository";
import { projectRunsWorkers } from "@/lib/worker-gate";
import { machineReadinessFor } from "@/lib/worker-service";
import { claimingMachineIds } from "@/lib/machine-limit";
import { columnIdsWithRole, roleOf } from "@/lib/columns";
import { check } from "@/lib/grants";
import { getBuildInfo } from "@/lib/build-info";
import { taskKeyOf } from "@/lib/task-key";
import { NOT_ARCHIVED } from "@/lib/task-archive";
import { agentSetupPrompt, agentSetupSteps } from "@/lib/agent-setup";
import type { ApiAgentSetup } from "@/types";

/**
 * The "Set up with your coding agent" screen: the prompt for this organisation, and what has been
 * done since the screen opened, read from the board. The board is the newest one this person
 * created since `since`; an older board is never claimed as the agent's work.
 */
export const GET = withAuth(async (request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }
  await connectDB();
  const origin = await originFor(db);
  if (!origin) {
    return NextResponse.json({ error: "This organisation has no address yet, so a coding agent has nothing to connect to" }, { status: 500 });
  }

  const now = new Date();
  const sinceParam = new URL(request.url).searchParams.get("since");
  const parsed = sinceParam ? new Date(sinceParam) : null;
  const since = parsed && !Number.isNaN(parsed.getTime()) && parsed <= now ? parsed : now;

  const [mcp, created] = await Promise.all([
    db.OAuthToken.exists({ user: user._id, createdAt: { $gte: since }, refreshExpiresAt: { $gt: now } }),
    db.Project.findOne(
      { createdBy: user._id, createdAt: { $gte: since } },
      "_id key name repositoryUrl repositories githubRepo gitlabRepo gitlabHost worker columns"
    )
      .sort({ createdAt: -1 })
      .lean(),
  ]);
  const project = created && (await check(db, user, String(created._id), "access")) ? created : null;

  let agent: { _id: unknown; name: string } | null = null;
  let firstTask: { _id: unknown; taskNumber: number; title: string; status: string; execution?: { runId?: unknown } } | null = null;
  let machine: ReturnType<typeof machineReadinessFor>["state"] = "none";
  if (project) {
    const [agentRow, taskRow, workers, claiming] = await Promise.all([
      project.worker?.agent ? db.Agent.findById(project.worker.agent, "_id name").lean() : null,
      db.Task.findOne({ project: project._id, ...NOT_ARCHIVED }, "_id taskNumber title status execution.runId").sort({ taskNumber: 1 }).lean(),
      db.Worker.find(
        { owner: user._id },
        "enabled owner lastSeenAt repos preflight command commandIssuedAt commandAckedAt bindingError halt"
      ).lean(),
      claimingMachineIds(db),
    ]);
    agent = agentRow;
    firstTask = taskRow;
    machine = machineReadinessFor(workers, project, now, claiming).state;
  }

  const steps = agentSetupSteps({
    mcpConnected: !!mcp || !!project,
    project: project ? { key: project.key, name: project.name, repositoryUrl: projectRepositoryUrl(project) ?? "" } : null,
    agentName: agent?.name ?? null,
    machine,
    runsOn: !!project && projectRunsWorkers(project.worker),
    firstTask: project && firstTask ? { key: taskKeyOf(project.key, firstTask.taskNumber), title: firstTask.title } : null,
  });

  const body: ApiAgentSetup = {
    since: since.toISOString(),
    prompt: agentSetupPrompt(origin, getBuildInfo().version),
    projectKey: project?.key ?? null,
    steps,
    run:
      project && agent && firstTask && !firstTask.execution?.runId && ["backlog", "approved"].includes(roleOf(project, firstTask.status) ?? "")
        ? {
            projectId: String(project._id),
            projectKey: project.key,
            taskId: String(firstTask._id),
            taskNumber: firstTask.taskNumber,
            agentId: String(agent._id),
            status: columnIdsWithRole(project, "approved")[0] ?? null,
          }
        : null,
  };
  return NextResponse.json(body);
});
