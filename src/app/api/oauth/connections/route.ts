import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { OAuthToken } from "@/models/oauthToken";
import { OAuthClient } from "@/models/oauthClient";

// A user's own active OAuth connections (one per issued access token).
export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const tokens = await OAuthToken.find({ user: user._id })
    .select("clientId allowedProjects accessExpiresAt createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const clientIds = [...new Set(tokens.map((t) => t.clientId))];
  const clients = await OAuthClient.find({ clientId: { $in: clientIds } })
    .select("clientId clientName")
    .lean();
  const nameMap = new Map(clients.map((c) => [c.clientId, c.clientName]));

  return NextResponse.json(
    tokens.map((t) => ({
      _id: String(t._id),
      clientId: t.clientId,
      clientName: nameMap.get(t.clientId) || "",
      allowedProjects: (t.allowedProjects || []).map(String),
      accessExpiresAt: t.accessExpiresAt,
      createdAt: t.createdAt,
    }))
  );
});

export const DELETE = withAuth(async (request, { user }) => {
  await connectDB();

  const { id } = await request.json();
  if (!id) {
    return NextResponse.json({ error: "Connection id is required" }, { status: 400 });
  }

  const result = await OAuthToken.findOneAndDelete({ _id: id, user: user._id });
  if (!result) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
});
