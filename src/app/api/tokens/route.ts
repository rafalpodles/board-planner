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

/**
 * Not awaited by the handler, and it asks whether mail is configured before it asks the database
 * anything: the scope is only ever read to fill a line in a message nobody may be sending.
 */
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

  // A minted token is never wider than the credential minting it. Omitting allowedProjects used to
  // mean "unscoped", so a token scoped to one project could mint itself the owner's whole account
  // in a single call — including instance admin, since an unscoped token keeps its role.
  const minterScope = (user.tokenScope || []).map(String);
  if (minterScope.length > 0 && scope.length === 0) {
    scope = minterScope;
  }

  // A token can only be scoped to projects its owner can access — and a scoped token may not
  // mint one that reaches past its own scope, which accessibleProjectIds already intersects.
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

  // Generate token: cp_ + 40 random hex chars
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

  // Return the raw token ONCE — it's never stored or retrievable again
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
  // Typed, not merely truthy: a JSON body can carry an operator object, and {"$ne": null} would
  // delete an arbitrary token of the caller's own rather than the one named
  if (typeof id !== "string" || !isValidObjectId(id)) {
    return NextResponse.json({ error: "Token id is required" }, { status: 400 });
  }

  const result = await ApiToken.findOneAndDelete({ _id: id, user: user._id });
  if (!result) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
});
