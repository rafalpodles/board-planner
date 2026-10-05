import type { ScopedDb } from "./db-scope";
import { organisationExport } from "./organisation-life-cycle";

// Recorded before the first byte: a download abandoned near its end has still carried the data away
export async function organisationExportResponse(db: ScopedDb, slug: string, record: () => Promise<void>): Promise<Response> {
  await record();
  const filename = `${slug.replace(/[^a-z0-9-]/g, "") || "organisation"}-export-${new Date().toISOString().slice(0, 10)}.ndjson.gz`;
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
}
