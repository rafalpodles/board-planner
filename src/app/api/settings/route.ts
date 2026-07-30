import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth, withAdmin } from "@/lib/middleware";
import { getSettings, Settings } from "@/models/settings";

const MAX_MODEL_LENGTH = 100;

export const GET = withAuth(async () => {
  await connectDB();
  const settings = await getSettings();
  return NextResponse.json({
    aiModel: settings.aiModel,
    pmDefaultModel: settings.pmDefaultModel || "",
    pmDefaultDailyTurnCap: settings.pmDefaultDailyTurnCap || 0,
  });
});

export const PUT = withAdmin(async (request) => {
  await connectDB();

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (body.aiModel !== undefined) {
    if (typeof body.aiModel !== "string" || !body.aiModel.trim()) {
      return NextResponse.json({ error: "aiModel is required" }, { status: 400 });
    }
    updates.aiModel = body.aiModel.trim();
  }

  if (body.pmDefaultModel !== undefined) {
    if (typeof body.pmDefaultModel !== "string" || body.pmDefaultModel.length > MAX_MODEL_LENGTH) {
      return NextResponse.json(
        { error: `pmDefaultModel must be a string up to ${MAX_MODEL_LENGTH} chars` },
        { status: 400 }
      );
    }
    updates.pmDefaultModel = body.pmDefaultModel.trim();
  }

  if (body.pmDefaultDailyTurnCap !== undefined) {
    const cap = body.pmDefaultDailyTurnCap;
    if (!Number.isInteger(cap) || cap < 0 || cap > 1000) {
      return NextResponse.json(
        { error: "pmDefaultDailyTurnCap must be an integer 0-1000 (0 = use the env default)" },
        { status: 400 }
      );
    }
    updates.pmDefaultDailyTurnCap = cap;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const settings = await Settings.findOneAndUpdate(
    {},
    { $set: updates },
    { upsert: true, returnDocument: "after" }
  );

  return NextResponse.json({
    aiModel: settings.aiModel,
    pmDefaultModel: settings.pmDefaultModel || "",
    pmDefaultDailyTurnCap: settings.pmDefaultDailyTurnCap || 0,
  });
});
