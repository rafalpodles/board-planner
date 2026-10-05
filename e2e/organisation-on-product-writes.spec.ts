import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { seed, E2E_MONGODB_URI, e2eDatabaseName, PROJECT_KEY, PROJECT_ID, SIBLING_TASK_ID, ADMIN_USERNAME, ADMIN_PASSWORD } from "./seed";
import { ADMIN_AUTH, SAME_ORIGIN, signInApi } from "./api";
import { backfillOrganisations } from "../src/lib/organisation-migration";
import { DEFAULT_ORGANISATION_ID } from "../src/lib/organisation-field";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

test.beforeEach(seed);

async function organisationCounts() {
  const conn = mongoose.createConnection(E2E_MONGODB_URI, { dbName: e2eDatabaseName(), autoIndex: false, autoCreate: false });
  await conn.asPromise();
  try {
    const { total } = await backfillOrganisations(conn, { apply: false });
    const probe = await conn.db!.collection("projects").findOne({ key: "TNT" });
    return { withoutAOrganisation: total, probeOrganisation: String(probe?.organisation) };
  } finally {
    await conn.close();
  }
}

test("what the app itself writes carries an organisation, whatever path wrote it", async ({ request }) => {
  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);

  const project = await request.post("/api/projects", { headers: ADMIN_AUTH, data: { name: "Organisation probe", key: "TNT" } });
  expect(project.status(), await project.text()).toBe(201);

  const task = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH, data: { title: "Probe task" } });
  expect(task.status(), await task.text()).toBe(201);
  const taskId = (await task.json())._id as string;

  const edited = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${taskId}`, {
    headers: ADMIN_AUTH,
    data: { title: "Probe task, edited", status: "in_progress" },
  });
  expect(edited.status(), await edited.text()).toBe(200);

  const commented = await request.post(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/comments`, {
    headers: ADMIN_AUTH,
    data: { body: "A comment" },
  });
  expect(commented.status(), await commented.text()).toBe(201);

  const sprint = await request.post(`/api/projects/${PROJECT_KEY}/sprints`, {
    headers: ADMIN_AUTH,
    data: { name: "Probe sprint", startDate: "2026-10-05", endDate: "2026-10-19" },
  });
  expect(sprint.status(), await sprint.text()).toBe(201);

  const token = await request.post("/api/tokens", { headers: ADMIN_AUTH, data: { name: "probe token" } });
  expect(token.status(), await token.text()).toBe(201);

  const user = await request.post("/api/users", {
    headers: SAME_ORIGIN,
    data: { username: "probeuser", password: "test1234", fullName: "Probe User", email: "probe@x.test" },
  });
  expect(user.status(), await user.text()).toBe(201);

  const invitation = await request.post(`/api/projects/${PROJECT_ID}/invitations`, {
    headers: SAME_ORIGIN,
    data: { email: "invitee@x.test", relation: "owner" },
  });
  expect(invitation.status(), await invitation.text()).toBe(201);

  expect(await organisationCounts()).toEqual({ withoutAOrganisation: 0, probeOrganisation: String(DEFAULT_ORGANISATION_ID) });
});
