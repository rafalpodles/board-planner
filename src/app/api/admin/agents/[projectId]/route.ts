import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";

const MAX_MODEL_LENGTH = 100;

// Deliberately narrow: this endpoint exists so an instance admin can govern
// agents, not as a second way to write arbitrary project config
export const PATCH = withAdmin(async (request, { params, user }) => {
  const { projectId } = await params;
  if (!isValidObjectId(projectId)) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    updates["pm.enabled"] = body.enabled;
  }

  if (body.lockedByInstance !== undefined) {
    if (typeof body.lockedByInstance !== "boolean") {
      return NextResponse.json({ error: "lockedByInstance must be a boolean" }, { status: 400 });
    }
    updates["pm.lockedByInstance"] = body.lockedByInstance;
  }

  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.length > MAX_MODEL_LENGTH) {
      return NextResponse.json(
        { error: `model must be a string up to ${MAX_MODEL_LENGTH} chars` },
        { status: 400 }
      );
    }
    updates["pm.model"] = body.model.trim();
  }

  if (body.dailyTurnCap !== undefined) {
    const cap = body.dailyTurnCap;
    if (!Number.isInteger(cap) || cap < 0 || cap > 1000) {
      return NextResponse.json(
        { error: "dailyTurnCap must be an integer 0-1000 (0 = inherit)" },
        { status: 400 }
      );
    }
    updates["pm.dailyTurnCap"] = cap;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await connectDB();
  const project = await Project.findByIdAndUpdate(projectId, { $set: updates }, {
    returnDocument: "after",
  }).lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const detail = Object.entries(updates)
    .map(([field, value]) => `${field.replace("pm.", "")}=${String(value)}`)
    .join(", ");
  await logProjectAudit(projectId, String(user._id), "settings_updated", `instance admin: ${detail}`);

  return NextResponse.json({
    _id: String(project._id),
    key: project.key,
    enabled: !!project.pm?.enabled,
    lockedByInstance: !!project.pm?.lockedByInstance,
    model: project.pm?.model || "",
    dailyTurnCap: project.pm?.dailyTurnCap || 0,
  });
});
