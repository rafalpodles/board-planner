import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * BP-1081. The route → group map is only as good as the server's log of who called what: a spec's
 * own request has to come out `direct`, and a page's fetch must not, or every route a page loads
 * would pin every group.
 */

const dir = process.env.E2E_REQUEST_LOG_DIR;
test.skip(!dir, "the request log is written only when E2E_REQUEST_LOG_DIR names a directory, as CI does");

function logged(path: string): { t: number; method: string; path: string; direct: boolean }[] {
  return readdirSync(dir!)
    .filter((file) => file.startsWith("requests-"))
    .flatMap((file) => readFileSync(join(dir!, file), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line))
    .filter((line) => line.path === path);
}

test("the app server logs a spec's own request as direct and a page's fetch as not", async ({ page, request }) => {
  const ownPath = `/api/request-log-probe/${randomUUID()}`;
  const pagePath = `/api/request-log-probe/${randomUUID()}`;

  await request.post(`${ownPath}?with=query`);
  await page.goto("/login");
  await page.evaluate((path) => fetch(path), pagePath);

  await expect.poll(() => logged(ownPath)).toEqual([{ t: expect.any(Number), method: "POST", path: ownPath, direct: true }]);
  await expect.poll(() => logged(pagePath)).toEqual([{ t: expect.any(Number), method: "GET", path: pagePath, direct: false }]);
});
