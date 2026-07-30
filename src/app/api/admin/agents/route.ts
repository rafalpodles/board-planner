import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { getSettings } from "@/models/settings";
import { isPmAvailable } from "@/lib/pm/config";
import { DEFAULT_PM_MODEL } from "@/lib/pm/openrouter";

export const GET = withAdmin(async () => {
  await connectDB();

  const [projects, settings] = await Promise.all([
    Project.find({}, "key name icon pm").sort({ key: 1 }).lean(),
    getSettings(),
  ]);

  return NextResponse.json({
    pmAvailable: isPmAvailable(),
    defaults: {
      pmDefaultModel: settings.pmDefaultModel || "",
      pmDefaultDailyTurnCap: settings.pmDefaultDailyTurnCap || 0,
      envModel: DEFAULT_PM_MODEL(),
    },
    projects: projects.map((project) => ({
      _id: String(project._id),
      key: project.key,
      name: project.name,
      icon: project.icon,
      enabled: !!project.pm?.enabled,
      lockedByInstance: !!project.pm?.lockedByInstance,
      model: project.pm?.model || "",
      dailyTurnCap: project.pm?.dailyTurnCap || 0,
      autonomy: {
        dailyReview: !!project.pm?.autonomy?.dailyReview,
        reviewIntervalHours: project.pm?.autonomy?.reviewIntervalHours || 24,
        handleNeedsHumanReview: !!project.pm?.autonomy?.handleNeedsHumanReview,
      },
    })),
  });
});
