import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth, withAdmin } from "@/lib/middleware";
import { getSettings, Settings } from "@/models/settings";

export const GET = withAuth(async () => {
  await connectDB();
  const settings = await getSettings();
  return NextResponse.json({ aiModel: settings.aiModel });
});

export const PUT = withAdmin(async (request) => {
  await connectDB();

  const body = await request.json();
  const { aiModel } = body;

  if (!aiModel || typeof aiModel !== "string" || !aiModel.trim()) {
    return NextResponse.json(
      { error: "aiModel is required" },
      { status: 400 }
    );
  }

  const settings = await Settings.findOneAndUpdate(
    {},
    { $set: { aiModel: aiModel.trim() } },
    { upsert: true, new: true }
  );

  return NextResponse.json({ aiModel: settings.aiModel });
});
