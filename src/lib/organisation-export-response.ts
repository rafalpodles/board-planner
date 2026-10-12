import type { ScopedDb } from "./db-scope";
import { organisationExport } from "./organisation-life-cycle";

export function gzipLinesResponse(lines: AsyncGenerator<string>, filename: string): Response {
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

export const exportFilename = (name: string, fallback: string) =>
  `${name.replace(/[^a-z0-9-]/g, "") || fallback}-export-${new Date().toISOString().slice(0, 10)}.ndjson.gz`;

// Recorded before the first byte: a download abandoned near its end has still carried the data away
export async function organisationExportResponse(db: ScopedDb, slug: string, record: () => Promise<void>): Promise<Response> {
  await record();
  return gzipLinesResponse(organisationExport(db), exportFilename(slug, "organisation"));
}
