import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { requireEntitlement, withProjectAccess } from "@/lib/middleware";
import { resolveEstimateField } from "@/lib/estimates";
import { projectStatusHistories } from "@/lib/status-history";
import { computeInsights, weeksOrRefusal, weeksSince } from "@/lib/insights";
import { isObjectIdSegment } from "@/lib/urls";

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
      db.Project.findById(projectId, "customFields estimateFieldId").lean(),
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

    return NextResponse.json({
      sprint: sprint
        ? { id: String(sprint._id), name: sprint.name, startDate: sprint.startDate, endDate: sprint.endDate }
        : null,
      category: category || null,
      ...computeInsights(scoped, { now: Date.now(), weeks: weeksShown, estimateField }),
    });
  })
);
