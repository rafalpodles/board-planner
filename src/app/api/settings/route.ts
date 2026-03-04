import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { getSettings, Settings } from "@/models/settings";

export const GET = withAuth(async () => {
  await connectDB();
  const settings = await getSettings();
  return NextResponse.json({ aiModel: settings.aiModel });
});

export const PUT = withAuth(async (request) => {
  await connectDB();

  const body = await request.json();
  const { aiModel } = body;

  if (!aiModel || typeof aiModel !== "string" || !aiModel.trim()) {
    return NextResponse.json(
      { error: "aiModel is required" },
      { status: 400 }
    );
  }

  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({ aiModel: aiModel.trim() });
  } else {
    settings.aiModel = aiModel.trim();
    await settings.save();
  }

  return NextResponse.json({ aiModel: settings.aiModel });
});
