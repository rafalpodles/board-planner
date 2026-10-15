import { test, expect, type APIRequestContext } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_KEY, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE, seed } from "./seed";
import { APP_NAME } from "../src/lib/brand";

/**
 * BP-1058. A task link pasted into Teams unfurled as a grey square and the app's name: no
 * og:image, and nothing to say which task. The unfurler fetches the HTML with no session, so the
 * spec does too.
 */

test.beforeEach(seed);

const TASK = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

async function head(request: APIRequestContext, path: string) {
  const response = await request.get(path, { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const html = await response.text();
  const meta = (property: string) =>
    html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`))?.[1] ?? null;
  const count = (property: string) => html.match(new RegExp(`<meta (?:property|name)="${property}"`, "g"))?.length ?? 0;
  return { html, meta, count };
}

test("a task link unfurls with its key and the branded image, without a session", async ({ request, baseURL }) => {
  const { html, meta, count } = await head(request, TASK);

  expect(meta("og:title")).toBe(`${SIBLING_TASK_KEY} — ${APP_NAME}`);
  expect(meta("twitter:card")).toBe("summary_large_image");
  expect(html).not.toContain(SIBLING_TASK_TITLE);

  const image = meta("og:image");
  expect(image).not.toBeNull();
  expect(count("og:image")).toBe(1);
  expect(new URL(image!).origin).toBe(new URL(baseURL!).origin);
  expect(meta("og:image:width")).toBe("1200");
  expect(meta("og:image:height")).toBe("630");

  const png = await request.get(image!);
  expect(png.status()).toBe(200);
  expect(png.headers()["content-type"]).toBe("image/png");
  const body = await png.body();
  expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("a link that is not a task keeps the app's name, with the same image", async ({ request }) => {
  const { meta, count } = await head(request, `/projects/${PROJECT_KEY}`);
  expect(meta("og:title")).toBe(APP_NAME);
  expect(meta("og:image")).toMatch(/\/opengraph-image/);
  expect(count("og:image")).toBe(1);
  expect(count("twitter:image")).toBe(1);
});
