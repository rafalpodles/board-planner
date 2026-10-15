import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { requireEntitlement, withProjectAccess } from "@/lib/middleware";
import { resolveEstimateField } from "@/lib/estimates";
import { projectStatusHistories } from "@/lib/status-history";
import { computeInsights, weeksOrRefusal, weeksSince } from "@/lib/insights";
import { isObjectIdSegment } from "@/lib/urls";
import { computeDora, type DoraChange } from "@/lib/dora";
import { DEFAULT_DEPLOYMENT_ENVIRONMENT } from "@/lib/github-deployments";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";
import { WEEK_MS } from "@/lib/insights";
import type { ScopedDb } from "@/lib/db-scope";
import type { IProject } from "@/types";

const DORA_LOOKBACK_MS = 13 * WEEK_MS;
const DORA_ROW_CAP = 5000;

type DoraProject = Pick<
  IProject,
  "repositoryUrl" | "githubRepo" | "gitlabRepo" | "gitlabHost" | "githubToken" | "deploymentEnvironment" | "deploymentSync"
>;

async function doraFor(db: ScopedDb, projectId: string, project: DoraProject, now: number, weeks: number) {
  if (!project.githubToken || repositoryProvider(project) !== "github" || !projectRepositoryUrl(project)) return null;
  const environment = project.deploymentEnvironment || DEFAULT_DEPLOYMENT_ENVIRONMENT;
  const since = new Date(now - weeks * WEEK_MS - DORA_LOOKBACK_MS);
  const [deployments, tasks] = await Promise.all([
    db.Deployment.find({ project: projectId, environment, startedAt: { $gte: since } }, "sha state startedAt finishedAt")
      .sort({ startedAt: -1 })
      .limit(DORA_ROW_CAP)
      .lean(),
    db.Task.find(
      { project: projectId, linkedPRs: { $elemMatch: { mergedAt: { $gte: since }, provider: { $in: ["github", null] } } } },
      "linkedPRs"
    )
      .sort({ _id: -1 })
      .limit(DORA_ROW_CAP)
      .lean(),
  ]);
  const changes: DoraChange[] = tasks.flatMap((task) =>
    (task.linkedPRs ?? [])
      .filter((pr) => pr.mergedAt && (pr.provider ?? "github") === "github")
      .map((pr) => ({ url: pr.url, headSha: pr.headSha ?? null, mergedAt: new Date(pr.mergedAt!) }))
  );
  return computeDora(deployments, changes, {
    now,
    weeks,
    environment,
    syncedThrough: project.deploymentSync?.syncedThrough ?? null,
    rateLimitedUntil: project.deploymentSync?.lastError ? null : (project.deploymentSync?.blockedUntil ?? null),
    lastError: project.deploymentSync?.lastError ?? null,
    capped: deployments.length === DORA_ROW_CAP || tasks.length === DORA_ROW_CAP,
  });
}

export const GET = withProjectAccess(
  requireEntitlement("reports.insights", async (request, { params, db }) => {
    const { projectId } = await params;
    const query = new URL(request.url).searchParams;

    const weeks = weeksOrRefusal(query.get("weeks"));
    if ("error" in weeks) return NextResponse.json({ error: weeks.error }, { status: 400 });

    const sprintId = query.get("sprint");
    if (sprintId !== null && !isObjectIdSegment(sprintId)) {
      return NextResponse.json({ error: "sprint must be a sprint id" }, { status: 400 });
    }

    await connectDB();
    const [project, sprint] = await Promise.all([
      db.Project.findById(
        projectId,
        "customFields estimateFieldId repositoryUrl githubRepo gitlabRepo gitlabHost githubToken deploymentEnvironment deploymentSync"
      ).lean(),
      sprintId ? db.Sprint.findOne({ _id: sprintId, project: projectId }, "name startDate endDate").lean() : null,
    ]);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (sprintId && !sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

    const estimate = resolveEstimateField({
      estimateFieldId: project.estimateFieldId,
      customFields: (project.customFields ?? []).map((field) => ({ ...field, _id: String(field._id) })) as never,
    });
    const estimateField = estimate ? { id: String(estimate._id), name: estimate.name } : undefined;

    const weeksShown =
      sprint && !query.get("weeks") ? weeksSince(sprint.startDate, Date.now()) : weeks.weeks;

    const histories = await projectStatusHistories(db, projectId, { estimateFieldId: estimateField?.id });
    const category = query.get("category");
    const scoped = histories.filter(
      (task) => (!sprint || task.sprint === String(sprint._id)) && (!category || task.category === category)
    );

    const now = Date.now();
    const dora = await doraFor(db, projectId, project as DoraProject, now, weeksShown);

    return NextResponse.json({
      dora,
      sprint: sprint
        ? { id: String(sprint._id), name: sprint.name, startDate: sprint.startDate, endDate: sprint.endDate }
        : null,
      category: category || null,
      ...computeInsights(scoped, { now, weeks: weeksShown, estimateField }),
    });
  })
);
