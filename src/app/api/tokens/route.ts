import { NextResponse } from "next/server";
import crypto from "crypto";
import { isValidObjectId } from "mongoose";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { isEmailConfigured } from "@/lib/email";
import { notifyCredentialCreated } from "@/lib/security-mail";
import { ApiToken } from "@/models/apiToken";
import { Project } from "@/models/project";

async function announceToken(
  owner: { email: string; username: string },
  name: string,
  projectIds: string[]
): Promise<void> {
  try {
    if (!owner.email || !isEmailConfigured()) return;
    let scope = "every board this account can reach";
    if (projectIds.length > 0) {
      const projects = await Project.find({ _id: { $in: projectIds } }).select("key").lean();
      const keys = projects.map((p) => p.key as string).sort();
      scope = keys.join(", ") || "no board";
    }
    await notifyCredentialCreated({
      email: owner.email,
      username: owner.username,
      kind: "token",
      name,
      scope,
    });
  } catch (err) {
    console.error("Could not announce the new token:", err);
  }
}

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const tokens = await ApiToken.find({ user: user._id })
    .select("name prefix allowedProjects lastUsedAt createdAt")
    .sort({ createdAt: -1 });

  return NextResponse.json(tokens);
});

export const POST = withAuth(async (request, { user }) => {
  await connectDB();

  const { name, allowedProjects } = await request.json();
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Token name is required" }, { status: 400 });
  }

  let scope: string[] = [];
  if (allowedProjects !== undefined && allowedProjects !== null) {
    if (!Array.isArray(allowedProjects) || !allowedProjects.every((p) => typeof p === "string")) {
      return NextResponse.json(
        { error: "allowedProjects must be an array of project IDs" },
        { status: 400 }
      );
    }
    scope = [...new Set(allowedProjects)];
  }

  const minterScope = (user.tokenScope || []).map(String);
  if (minterScope.length > 0 && scope.length === 0) {
    scope = minterScope;
  }

  if (scope.length > 0) {
    const ids = await accessibleProjectIds(user);
    const accessible = await Project.find(ids === null ? {} : { _id: { $in: ids } })
      .select("_id")
      .lean();
    const accessibleIds = new Set(accessible.map((p) => p._id.toString()));
    const invalid = scope.filter((id) => !accessibleIds.has(id));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: "You don't have access to one or more of the selected projects" },
        { status: 400 }
      );
    }
  }

  const rawToken = `cp_${crypto.randomBytes(20).toString("hex")}`;
  const prefix = rawToken.substring(0, 11); // "cp_" + 8 hex
  const tokenHash = await bcrypt.hash(rawToken, 10);

  const token = await ApiToken.create({
    user: user._id,
    name: name.trim(),
    tokenHash,
    prefix,
    allowedProjects: scope,
  });

  void announceToken(user, token.name, scope);

  return NextResponse.json({
    _id: token._id,
    name: token.name,
    prefix: token.prefix,
    allowedProjects: token.allowedProjects,
    token: rawToken,
    createdAt: token.createdAt,
  }, { status: 201 });
});

export const DELETE = withAuth(async (request, { user }) => {
  await connectDB();

  const { id } = await request.json();
  if (typeof id !== "string" || !isValidObjectId(id)) {
    return NextResponse.json({ error: "Token id is required" }, { status: 400 });
  }

  const result = await ApiToken.findOneAndDelete({ _id: id, user: user._id });
  if (!result) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
});
