import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { getSettings } from "@/models/settings";
import { pmAvailability } from "@/lib/pm/config";
import { DEFAULT_PM_MODEL } from "@/lib/pm/openrouter";
import { describeManagedModels, managedModelsFromEnv } from "@/lib/managed-models";
import { organisationDomain } from "@/lib/organisation-host";

export const GET = withAdmin(async (_request, { db }) => {
  await connectDB();

  const [projects, settings, availability] = await Promise.all([
    db.Project.find({}, "key name icon pm").sort({ key: 1 }).lean(),
    getSettings(db),
    pmAvailability(db),
  ]);

  return NextResponse.json({
    pmAvailable: availability?.available ?? false,
    pmNeedsPlan: availability?.needsPlan ?? false,
    pmKeyUnreadable: availability?.keyUnreadable ?? false,
    pmLocked: availability?.locked ?? false,
    managedModels:
      organisationDomain() === null
        ? null
        : { onPlatformKey: !settings.openrouterKey, allowed: managedModelsFromEnv(), description: describeManagedModels() },
    defaults: {
      pmDefaultModel: settings.pmDefaultModel || "",
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
      autonomy: {
        dailyReview: !!project.pm?.autonomy?.dailyReview,
        reviewIntervalHours: project.pm?.autonomy?.reviewIntervalHours || 24,
        handleNeedsHumanReview: !!project.pm?.autonomy?.handleNeedsHumanReview,
      },
    })),
  });
});
