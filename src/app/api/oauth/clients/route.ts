import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { OAuthClient } from "@/models/oauthClient";
import { OAuthToken } from "@/models/oauthToken";
import { OAuthCode } from "@/models/oauthCode";
import { OAuthConsent } from "@/models/oauthConsent";

// Registered OAuth clients (via Dynamic Client Registration). Admin only.
export const GET = withAdmin(async () => {
  await connectDB();

  const clients = await OAuthClient.find()
    .select("clientId clientName redirectUris createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const counts = await OAuthToken.aggregate<{ _id: string; n: number }>([
    { $group: { _id: "$clientId", n: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [c._id, c.n]));

  return NextResponse.json(
    clients.map((c) => ({
      _id: String(c._id),
      clientId: c.clientId,
      clientName: c.clientName,
      redirectUris: c.redirectUris,
      createdAt: c.createdAt,
      tokenCount: countMap.get(c.clientId) || 0,
    }))
  );
});

export const DELETE = withAdmin(async (request) => {
  await connectDB();

  const { id } = await request.json();
  if (!id) {
    return NextResponse.json({ error: "Client id is required" }, { status: 400 });
  }

  const client = await OAuthClient.findById(id);
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Cascade: revoke everything issued to this client so no orphaned tokens keep working.
  await OAuthToken.deleteMany({ clientId: client.clientId });
  await OAuthCode.deleteMany({ clientId: client.clientId });
  await OAuthConsent.deleteMany({ clientId: client.clientId });
  await OAuthClient.deleteOne({ _id: client._id });

  return NextResponse.json({ ok: true });
});
