import type { ScopedDb } from "./db-scope";
import { organisationExport } from "./organisation-life-cycle";

// The audit row is written when the last line has gone, so a download that failed halfway is not recorded as taken
export function organisationExportResponse(db: ScopedDb, slug: string, onComplete: () => Promise<void>): Response {
  const filename = `${slug.replace(/[^a-z0-9-]/g, "") || "organisation"}-export-${new Date().toISOString().slice(0, 10)}.ndjson.gz`;
  const lines = organisationExport(db);
  const body = new ReadableStream<string>({
    async pull(controller) {
      const next = await lines.next();
      if (next.done) {
        controller.close();
        await onComplete();
      } else {
        controller.enqueue(next.value);
      }
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
