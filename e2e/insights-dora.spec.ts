import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { GITHUB_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, SIBLING_TASK_NUMBER, seed, seedRepository } from "./seed";
import { signIn } from "./session";

/**
 * BP-878. Deployments read from a stubbed GitHub by the real sync, stored, and figured into DORA on
 * the Insights page — by a person signed in on a Pro organisation.
 */

const ORGANISATION_ID = new mongoose.Types.ObjectId("000000000000000000000001");
const REPO = "https://github.com/example/board";
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function setPlan(plan: "free" | "pro") {
  await (await db())
    .collection("organisations")
    .updateOne({ _id: ORGANISATION_ID }, { $set: { "entitlements.plan": plan, "entitlements.features": [] } }, { upsert: true });
}

test.beforeEach(async () => {
  await seed();
  await seedRepository({ repositoryUrl: REPO, githubToken: "e2e-token-passed-through" });
});

test.afterEach(async () => {
  await (await db()).collection("organisations").deleteOne({ _id: ORGANISATION_ID });
  await mongoose.disconnect();
});

/**
 * One merged pull request on the seeded sibling task, merged six hours ago, whose head commit was
 * never deployed by itself (a squash). Production: a success, a failure, then a success that was
 * still running at first. Staging is not production and must be left out.
 */
function scenario(over: Record<string, unknown> = {}) {
  return {
    pulls: [
      {
        number: 51,
        title: "Ship the export",
        state: "closed",
        html_url: `${REPO}/pull/51`,
        merged_at: ago(6),
        head: { ref: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/export`, sha: "head51" },
        updated_at: ago(6),
      },
    ],
    deployments: [
      { id: 1, sha: "m1", ref: "main", environment: "production", created_at: ago(5), statuses: [{ state: "success", created_at: ago(4) }] },
      { id: 2, sha: "m2", ref: "main", environment: "production", created_at: ago(3), statuses: [{ state: "failure", created_at: ago(2.5) }] },
      {
        id: 3,
        sha: "m3",
        ref: "main",
        environment: "production",
        created_at: ago(2),
        statuses: [
          { state: "in_progress", created_at: ago(1.9) },
          { state: "success", created_at: ago(1) },
        ],
      },
      { id: 4, sha: "s1", ref: "main", environment: "staging", created_at: ago(1), statuses: [{ state: "failure", created_at: ago(0.5) }] },
    ],
    ...over,
  };
}

async function github(request: APIRequestContext, body: Record<string, unknown>) {
  expect((await request.post(`${GITHUB_STUB_URL}/control`, { data: body })).status()).toBe(200);
}

async function askedFor(request: APIRequestContext): Promise<string[]> {
  return (await request.get(`${GITHUB_STUB_URL}/asked`)).json();
}

async function syncNow(request: APIRequestContext) {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, { headers: ADMIN_AUTH, data: {} });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function stored() {
  return (await db()).collection("deployments").find({ project: PROJECT_ID }).sort({ githubId: 1 }).toArray();
}

test("production deployments are stored once and drawn as DORA on the Insights page", async ({ page, request }) => {
  await setPlan("pro");
  const given = scenario();
  await github(request, given);

  const first = await syncNow(request);
  expect(first.deployments).toMatchObject({ ran: true, inserted: 3, finished: 3 });
  const second = await syncNow(request);
  expect(second.deployments).toMatchObject({ ran: true, inserted: 0, finished: 0 });

  const rows = await stored();
  expect(rows.map((r) => [r.githubId, r.environment, r.state])).toEqual([
    [1, "production", "success"],
    [2, "production", "failure"],
    [3, "production", "success"],
  ]);
  const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  expect(project?.deploymentSync?.syncedThrough?.toISOString()).toBe(given.deployments[2].created_at);

  await signIn(page);
  const answered = page.waitForResponse((res) => /\/insights\?/.test(res.url()));
  await page.goto(`/projects/${PROJECT_KEY}/insights`);
  const body = await (await answered).json();
  // By hand: 2 of 3 succeeded → 1 failure in 3 = 33%. The pull request merged 6 h ago shipped with
  // the first success after it, live 4 h ago: 2 h. The failure went live 2.5 h ago and the next
  // success 1 h ago: 1.5 h, which reads "2 h".
  expect(body.dora).toMatchObject({
    environment: "production",
    deployments: 3,
    changeFailureRate: 1 / 3,
    leadTimeForChanges: { count: 1 },
    timeToRestore: { count: 1 },
    unrestored: 0,
  });
  expect(Math.round(body.dora.leadTimeForChanges.medianMs / 60_000)).toBe(120);
  expect(Math.round(body.dora.timeToRestore.medianMs / 60_000)).toBe(90);

  const figures = page.getByTestId("insights-dora-figures");
  await expect(figures).toContainText("Change failure rate33%");
  await expect(figures).toContainText("Lead time for changes2 h");
  await expect(figures).toContainText("Time to restore2 h");
  await expect(figures).toContainText("3 finished to production");
  await page.getByTestId("insights-dora").getByText("Show as table").click();
  const thisWeek = page.getByTestId("insights-dora").getByRole("table").locator("tbody tr").last().locator("td");
  await expect(thisWeek.nth(1)).toHaveText("2");
  await expect(thisWeek.nth(2)).toHaveText("1");
  if (process.env.INSIGHTS_SHOTS_DIR) {
    const dora = page.getByTestId("insights-dora");
    await dora.scrollIntoViewIfNeeded();
    await dora.screenshot({ path: `${process.env.INSIGHTS_SHOTS_DIR}/dora-desktop.png` });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await page.getByTestId("insights-dora").scrollIntoViewIfNeeded();
    await page.getByTestId("insights-dora").screenshot({ path: `${process.env.INSIGHTS_SHOTS_DIR}/dora-phone.png` });
  }
});

test("the second sync asks only for the newest page and nothing about finished deployments", async ({ request }) => {
  await setPlan("pro");
  await github(request, scenario());
  await syncNow(request);
  await github(request, scenario());

  await syncNow(request);

  const deploymentCalls = (await askedFor(request)).filter((path) => path.includes("/deployments"));
  expect(deploymentCalls).toEqual(["/repos/example/board/deployments"]);
});

test("a Free organisation's sync never asks GitHub about deployments, and Insights stays refused", async ({ request }) => {
  await setPlan("free");
  await github(request, scenario());

  const result = await syncNow(request);

  expect(result).not.toHaveProperty("deployments");
  expect((await askedFor(request)).some((path) => path.includes("/deployments"))).toBe(false);
  expect(await stored()).toEqual([]);
  const insights = await request.get(`/api/projects/${PROJECT_KEY}/insights`, { headers: ADMIN_AUTH });
  expect(insights.status()).toBe(402);
  expect(await insights.text()).not.toContain("dora");
});

test("a rate limit pauses deployments until it resets, and the pull requests still sync", async ({ request }) => {
  await setPlan("pro");
  await github(request, scenario({ deploymentsLimited: true }));

  const result = await syncNow(request);
  expect(result).toMatchObject({ synced: true, prsLinked: 1, deployments: { ran: false, reason: "rate limited" } });
  const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  expect(project?.deploymentSync?.blockedUntil?.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

  await github(request, scenario());
  const again = await syncNow(request);

  expect(again.deployments).toMatchObject({ ran: false, reason: "rate limited", requests: 0 });
  expect((await askedFor(request)).some((path) => path.includes("/deployments"))).toBe(false);
});

test("a first read gives old deployments their outcome too, not only the last few days'", async ({ request }) => {
  await setPlan("pro");
  await github(request, {
    ...scenario(),
    deployments: [
      { id: 7, sha: "old", ref: "main", environment: "production", created_at: ago(24 * 10), statuses: [{ state: "success", created_at: ago(24 * 10 - 1) }] },
      { id: 8, sha: "new", ref: "main", environment: "production", created_at: ago(2), statuses: [{ state: "failure", created_at: ago(1) }] },
    ],
  });

  await syncNow(request);

  expect((await stored()).map((r) => [r.githubId, r.state])).toEqual([
    [7, "success"],
    [8, "failure"],
  ]);
});

test("a token GitHub will not list deployments for says so on the page, and Sync can ask again at once", async ({ page, request }) => {
  await setPlan("pro");
  await github(request, scenario({ deploymentsRefused: true }));

  const result = await syncNow(request);
  expect(result).toMatchObject({ synced: true, deployments: { ran: false, reason: "failed", error: "GitHub answered 403" } });

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/insights`);
  await expect(page.getByTestId("insights-dora")).toContainText("GitHub refused to list this board's deployments (GitHub answered 403)");

  await github(request, scenario());
  const again = await syncNow(request);
  expect(again.deployments).toMatchObject({ ran: true, inserted: 3 });
  await page.reload();
  await expect(page.getByTestId("insights-dora-figures")).toContainText("Change failure rate33%");
});
