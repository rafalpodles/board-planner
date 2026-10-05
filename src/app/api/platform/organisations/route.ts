import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { scoped } from "@/lib/db-scope";
import { licenceOf } from "@/lib/organisation";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";
import { Organisation } from "@/models/organisation";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

// Metadata only: who the organisations are and what they hold, never anything inside them
export const GET = withPlatformRequest(async (request, { keyId }) => {
  const query = new URL(request.url).searchParams;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.get("limit")) || DEFAULT_LIMIT));
  const after = query.get("after");
  if (after !== null && !isValidObjectId(after)) {
    return NextResponse.json({ error: "after must be an organisation id" }, { status: 400 });
  }

  const rows = await Organisation.find(after ? { _id: { $gt: after } } : {})
    .sort({ _id: 1 })
    .limit(limit + 1)
    .select("name slug licenceKey")
    .lean();
  const page = rows.slice(0, limit);

  const organisations = await Promise.all(
    page.map(async (row) => {
      const db = scoped(row._id);
      const [members, projects] = await Promise.all([
        db.User.countDocuments({ kind: { $ne: "machine" }, deactivatedAt: null }),
        db.Project.countDocuments({}),
      ]);
      const licence = licenceOf(row);
      const active = licence?.verdict === "valid" || licence?.verdict === "grace";
      return {
        id: String(row._id),
        name: row.name,
        slug: row.slug ?? null,
        createdAt: row._id.getTimestamp().toISOString(),
        plan: active ? licence.payload.plan : "free",
        licence: licence ? { verdict: licence.verdict, customer: licence.payload?.customer ?? null, expiresAt: licence.payload?.expiresAt ?? null } : null,
        members,
        projects,
      };
    })
  );

  await logPlatformAudit({ action: "organisations_listed", keyId, detail: `${organisations.length} organisation(s)${after ? ` after ${after}` : ""}` });
  return NextResponse.json({ organisations, next: rows.length > limit ? String(page[page.length - 1]._id) : null });
});
