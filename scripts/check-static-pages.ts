/**
 * Fails when a build prerendered a page nobody allowed (BP-313). Run after `npm run build`:
 *
 *   node scripts/check-static-pages.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unexpectedStaticRoutes } from "../src/lib/static-pages.ts";

const manifestPath = join(process.env.NEXT_DIST_DIR || ".next", "prerender-manifest.json");
const unexpected = unexpectedStaticRoutes(JSON.parse(readFileSync(manifestPath, "utf8")));

if (unexpected.length > 0) {
  console.error(
    `::error::prerendered without a request, so served with no CSP nonce: ${unexpected.join(", ")}. ` +
      "Make the page dynamic, or allow it in src/lib/static-pages.ts if it needs no script."
  );
  process.exit(1);
}
console.log("No page is prerendered outside src/lib/static-pages.ts");
