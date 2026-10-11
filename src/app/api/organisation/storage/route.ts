import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/middleware";
import { storageLimitOf } from "@/lib/organisation-limits";
import { organisationUploads } from "@/lib/upload-ownership";

export const GET = withAdmin(async (_request, { db }) => {
  const [storedBytes, limit] = await Promise.all([organisationUploads(db)?.bytesStored() ?? 0, storageLimitOf(db)]);
  return NextResponse.json({ storedBytes, limitBytes: limit.bytes || null, raisedBy: limit.raisedBy });
});
