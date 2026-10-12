import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { pmAvailability } from "@/lib/pm/config";

// What the new-project wizard cannot learn from a project, because there is none yet
export const GET = withAdmin(async (_request, { db }) => {
  await connectDB();
  const availability = await pmAvailability(db);
  return NextResponse.json({
    pmAvailable: availability?.available ?? false,
    pmNeedsPlan: availability?.needsPlan ?? false,
    pmKeyUnreadable: availability?.keyUnreadable ?? false,
    pmLocked: availability?.locked ?? false,
  });
});
