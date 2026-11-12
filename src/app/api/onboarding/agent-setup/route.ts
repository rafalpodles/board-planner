import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { originFor } from "@/lib/organisation-host";
import { projectRepositoryUrl } from "@/lib/repository";
import { projectRunsWorkers } from "@/lib/worker-gate";
import { machineReadinessFor } from "@/lib/worker-service";
import { claimingMachineIds } from "@/lib/machine-limit";
import { columnIdsWithRole } from "@/lib/columns";
import { taskKeyOf } from "@/lib/task-key";
import { agentSetupPrompt, agentSetupSteps } from "@/lib/agent-setup";
import type { ApiAgentSetup } from "@/types";

/**
 * The "Set up with your coding agent" screen: the prompt for this organisation, and what has been
 * done since the screen opened, read from the board. The board is the newest one this person
 * created since `since`; an older board is never claimed as the agent's work.
 */
export const GET = withAuth(async (request, { user, db }) => {
  await connectDB();
  const origin = await originFor(db);
  if (!origin) {
    return NextResponse.json({ error: "This instance has no PUBLIC_ORIGIN, so a coding agent has no address to connect to" }, { status: 500 });
  }

  const now = new Date();
  const sinceParam = new URL(request.url).searchParams.get("since");
  const parsed = sinceParam ? new Date(sinceParam) : null;
  const since = parsed && !Number.isNaN(parsed.getTime()) && parsed <= now ? parsed : now;

  const [mcp, project] = await Promise.all([
    db.OAuthToken.exists({ user: user._id, refreshExpiresAt: { $gt: now } }),
    db.Project.findOne(
      { createdBy: user._id, createdAt: { $gte: since } },
      "_id key name repositoryUrl repositories githubRepo gitlabRepo gitlabHost worker columns"
    )
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  let agent: { _id: unknown; name: string } | null = null;
  let firstTask: { _id: unknown; taskNumber: number; title: string } | null = null;
  let machine: ReturnType<typeof machineReadinessFor>["state"] = "none";
  if (project) {
    const [agentRow, taskRow, workers, claiming] = await Promise.all([
      project.worker?.agent ? db.Agent.findById(project.worker.agent, "_id name").lean() : null,
      db.Task.findOne({ project: project._id }, "_id taskNumber title").sort({ taskNumber: 1 }).lean(),
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
    mcpConnected: !!mcp,
    project: project ? { key: project.key, name: project.name, repositoryUrl: projectRepositoryUrl(project) ?? "" } : null,
    agentName: agent?.name ?? null,
    machine,
    runsOn: !!project && projectRunsWorkers(project.worker),
    firstTask: project && firstTask ? { key: taskKeyOf(project.key, firstTask.taskNumber), title: firstTask.title } : null,
  });

  const body: ApiAgentSetup = {
    since: since.toISOString(),
    prompt: agentSetupPrompt(origin),
    steps,
    run:
      project && agent && firstTask
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
