import { test, expect } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { ESTIMATE_SPRINT_ID, PROJECT_ID, seed, seedSprintEstimates } from "./seed";

test.beforeEach(async () => {
  await seed();
  await seedSprintEstimates();
});

test("sums a real number and a value the inline editor stored as a string, and treats an unconvertible legacy value and an absent one as zero", async ({
  request,
}) => {
  const response = await request.get(`/api/projects/${PROJECT_ID}/sprints`, {
    headers: ADMIN_AUTH,
  });

  expect(response.status(), await response.text()).toBe(200);

  const sprints = await response.json();
  const sprint = sprints.find((s: { _id: string }) => s._id === String(ESTIMATE_SPRINT_ID));

  expect(sprint.taskCount).toBe(4);
  expect(sprint.doneCount).toBe(2);
  expect(sprint.estimateTotal).toBe(8);
  expect(sprint.estimateDone).toBe(5);
});
