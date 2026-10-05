import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withPlatformRequest } from "@/lib/platform-route";
import { PlatformAuditLog } from "@/models/platformAuditLog";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export const GET = withPlatformRequest(async (request) => {
  const query = new URL(request.url).searchParams;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.get("limit")) || DEFAULT_LIMIT));
  const before = query.get("before");
  if (before !== null && !isValidObjectId(before)) {
    return NextResponse.json({ error: "before must be an entry id" }, { status: 400 });
  }

  const rows = await PlatformAuditLog.find(before ? { _id: { $lt: before } } : {})
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const page = rows.slice(0, limit);
  return NextResponse.json({
    entries: page.map((row) => ({
      id: String(row._id),
      action: row.action,
      keyId: row.keyId,
      subject: row.subject ? String(row.subject) : null,
      detail: row.detail,
      createdAt: row.createdAt,
    })),
    next: rows.length > limit ? String(page[page.length - 1]._id) : null,
  });
});
