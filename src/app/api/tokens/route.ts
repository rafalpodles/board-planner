import { NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { ApiToken } from "@/models/apiToken";
import { Project } from "@/models/project";

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

  // A token can only be scoped to projects its owner can access.
  if (scope.length > 0) {
    const accessible = await Project.find(
      user.role === "admin" ? {} : { _id: { $in: user.allowedProjects || [] } }
    )
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
  if (!id) {
    return NextResponse.json({ error: "Token id is required" }, { status: 400 });
  }

  const result = await ApiToken.findOneAndDelete({ _id: id, user: user._id });
  if (!result) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
});
