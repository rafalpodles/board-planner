import { NextResponse } from "next/server";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAdmin } from "@/lib/middleware";
import { getOrganisation } from "@/lib/organisation";
import { organisationExport } from "@/lib/organisation-life-cycle";

export const GET = withAdmin(async (_request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }
  const organisation = await getOrganisation(db.organisation);
  const name = (organisation.slug || "organisation").replace(/[^a-z0-9-]/g, "");
  const filename = `${name}-export-${new Date().toISOString().slice(0, 10)}.ndjson.gz`;

  void logInstanceAudit(db, { action: "organisation_exported", user: user._id, actorUsername: user.username, target: name });
  const lines = organisationExport(db);
  const body = new ReadableStream<string>({
    async pull(controller) {
      const next = await lines.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await lines.return(undefined);
    },
  })
    .pipeThrough(new TextEncoderStream())
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
