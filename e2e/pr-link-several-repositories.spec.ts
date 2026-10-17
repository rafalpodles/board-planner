import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { GITHUB_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  E2E_MONGODB_URI,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
  seedRepository,
} from "./seed";

/**
 * BP-1068. A project that lists several repositories is synced in a round per repository, so a task
 * that a run changed in two of them carries the pull request of each. What a round saw is named by
 * address, which is what keeps one repository's round from touching the links the other's gave the same
 * task: a pull request outside this round's window is unknown, not gone.
 */

const WEB = "https://github.com/example/web";
const API = "https://github.com/example/api";
const BRANCH = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/greet-and-say-goodbye`;

function pull(repository: string, number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `Change ${number}`,
    state: "open",
    html_url: `${repository}/pull/${number}`,
    merged_at: null,
    head: { ref: BRANCH, sha: `sha-${number}` },
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

async function github(request: APIRequestContext, repositories: Record<string, unknown[]>) {
  const response = await request.post(`${GITHUB_STUB_URL}/control`, { data: { pulls: [], repositories } });
  expect(response.status()).toBe(200);
}

async function sync(request: APIRequestContext) {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, { headers: ADMIN_AUTH, data: {} });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function linkedUrls(): Promise<string[]> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const task = await mongoose.connection.db!.collection("tasks").findOne({ _id: SIBLING_TASK_ID });
    return ((task?.linkedPRs ?? []) as { url: string }[]).map((link) => link.url).sort();
  } finally {
    await mongoose.disconnect();
  }
}

test.beforeEach(async () => {
  await seed();
  await seedRepository({ repositoryUrl: WEB, githubToken: "e2e-token" });
  await mongoose.connect(E2E_MONGODB_URI);
  await mongoose.connection.db!.collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        repositories: [
          { _id: new mongoose.Types.ObjectId(), url: WEB, name: "web" },
          { _id: new mongoose.Types.ObjectId(), url: API, name: "api" },
        ],
      },
    }
  );
  await mongoose.disconnect();
});

test("a task changed in two repositories carries the pull request of each", async ({ request }) => {
  await github(request, { "example/web": [pull(WEB, 41)], "example/api": [pull(API, 7)] });

  const result = await sync(request);

  expect(result).toMatchObject({ synced: true, prsFound: 2, prsLinked: 2 });
  expect(result).not.toHaveProperty("failed");
  expect(await linkedUrls()).toEqual([`${API}/pull/7`, `${WEB}/pull/41`]);
});

test("a repository that cannot be read does not cost the task its link there, and is named", async ({ request }) => {
  await github(request, { "example/web": [pull(WEB, 41)], "example/api": [pull(API, 7)] });
  await sync(request);

  // The second round: GitHub answers for web and refuses api
  await github(request, { "example/web": [pull(WEB, 41, { title: "Retitled" })] });
  const result = await sync(request);

  expect(result).toMatchObject({ synced: true, prsLinked: 1, failed: [{ repository: API }] });
  expect(await linkedUrls()).toEqual([`${API}/pull/7`, `${WEB}/pull/41`]);
});

test("a repository whose window no longer holds a pull request keeps the link another round gave", async ({ request }) => {
  await github(request, { "example/web": [pull(WEB, 41)], "example/api": [pull(API, 7)] });
  await sync(request);

  // Both answer, and api's window has moved on: what it did not see is unknown, not gone
  await github(request, { "example/web": [pull(WEB, 41)], "example/api": [] });
  const result = await sync(request);

  expect(result).toMatchObject({ prsUnlinked: 0 });
  expect(await linkedUrls()).toEqual([`${API}/pull/7`, `${WEB}/pull/41`]);
});

test("a repository that is not GitHub's is left to the GitLab sync, and never asked of GitHub", async ({ request }) => {
  await mongoose.connect(E2E_MONGODB_URI);
  await mongoose.connection.db!.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { "repositories.1.url": "https://gitlab.com/example/api" } }
  );
  await mongoose.disconnect();
  await github(request, { "example/web": [pull(WEB, 41)] });

  const result = await sync(request);

  expect(result).toMatchObject({ prsLinked: 1 });
  // not a failure either: nothing is wrong with a repository another provider's sync reads
  expect(result).not.toHaveProperty("failed");
  const asked: string[] = await (await request.get(`${GITHUB_STUB_URL}/asked`)).json();
  expect(asked.every((path) => path.startsWith("/repos/example/web/"))).toBe(true);
  expect(await linkedUrls()).toEqual([`${WEB}/pull/41`]);
});
