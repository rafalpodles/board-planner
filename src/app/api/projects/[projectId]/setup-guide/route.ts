import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { projectRepositoryUrl } from "@/lib/repository";
import { isWorkerLockedByInstance } from "@/lib/worker-gate";
import { machineReadinessFor } from "@/lib/worker-service";
import { claimingMachineIds } from "@/lib/machine-limit";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";
import {
  columnsCustomised,
  fieldsCustomised,
  MAX_DISMISSED_SETUP_GUIDES,
  setupGuideComplete,
  setupGuideSteps,
} from "@/lib/setup-guide";
import type { ApiSetupGuide } from "@/types";

const NOTHING: ApiSetupGuide = { show: false, steps: [] };

/**
 * The setup guide in the sidebar. Only somebody who can change the board's settings is shown one,
 * and every step is derived from data that already exists: nothing is stored per step. The machine
 * step reads the reader's own machines only, as the handover readiness does; the organisation's
 * steps are an instance admin's alone.
 */
export const GET = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  if (!(await check(db, user, projectId, "admin"))) return NextResponse.json(NOTHING);

  const instanceAdmin = user.role === "admin";
  const [project, workers, claiming, hasTasks, grantCount, hasSprint, handedOver, mcpClient, me, settings, organisation] =
    await Promise.all([
      db.Project.findById(
        projectId,
        "repositoryUrl githubRepo gitlabRepo worker columns customFields categories notificationChannels webhooks pm"
      ).lean(),
      db.Worker.find(
        { owner: user._id },
        "enabled owner lastSeenAt repos preflight command commandIssuedAt commandAckedAt bindingError halt"
      ).lean(),
      claimingMachineIds(db),
      db.Task.exists({ project: projectId }),
      db.Grant.countDocuments({ objectType: "project", object: projectId }),
      db.Sprint.exists({ project: projectId }),
      db.Task.exists({ project: projectId, agent: { $ne: null } }),
      db.OAuthToken.exists({ user: user._id, refreshExpiresAt: { $gt: new Date() } }),
      db.User.findById(user._id, "dismissedSetupGuides").lean(),
      instanceAdmin ? db.Settings.findOne({}, "openrouterKey sso").lean() : null,
      instanceAdmin ? getOrganisation(db.organisation) : null,
    ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const steps = setupGuideSteps({
    hasTasks: !!hasTasks,
    grantCount,
    columnsCustomised: columnsCustomised(project.columns),
    fieldsCustomised: fieldsCustomised(project.customFields, project.categories),
    hasSprint: !!hasSprint,
    repositoryUrl: projectRepositoryUrl(project),
    hasChannel: (project.notificationChannels?.length ?? 0) > 0,
    hasWebhook: (project.webhooks?.length ?? 0) > 0,
    mcpConnected: !!mcpClient,
    pmEnabled: !!project.pm?.enabled,
    ownAiKey: !!settings?.openrouterKey,
    workerEnabled: !!project.worker?.enabled,
    lockedByInstance: isWorkerLockedByInstance(project.worker),
    machine: machineReadinessFor(workers, project, new Date(), claiming).state,
    handedOver: !!handedOver,
    ssoConfigured: !!settings?.sso,
    paidPlan: organisation?.entitlements.plan === "pro" && organisation.entitlements.trial !== true,
    readerIsInstanceAdmin: instanceAdmin,
    hosted: organisationDomain() !== null,
  });

  const dismissed = (me?.dismissedSetupGuides ?? []).some((id) => String(id) === String(projectId));
  const body: ApiSetupGuide = { show: !dismissed && !setupGuideComplete(steps), steps };
  return NextResponse.json(body);
});

export const PUT = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const me = await db.User.findById(user._id, "dismissedSetupGuides").lean();
  if (!(me?.dismissedSetupGuides ?? []).some((id) => String(id) === String(projectId))) {
    await db.User.updateOne(
      { _id: user._id },
      { $push: { dismissedSetupGuides: { $each: [projectId], $slice: -MAX_DISMISSED_SETUP_GUIDES } } }
    );
  }
  return NextResponse.json({ ok: true });
});
