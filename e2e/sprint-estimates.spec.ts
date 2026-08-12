import { test, expect } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { ESTIMATE_SPRINT_ID, PROJECT_ID, seed, seedSprintEstimates } from "./seed";

/**
 * BP-208 Task 11. GET /sprints is on the board's poll path (page.tsx), so its estimate
 * accumulators have to survive real documents, not just a mocked Task.aggregate — a unit test
 * mocking that call only proves the pipeline's shape, never what MongoDB does with a string in
 * $convert. This is the one place that question gets a real database to answer it. No UI renders
 * these two fields yet (that's BP-208 Task 12/13), so this is an API-level check — see
 * e2e/field-history.spec.ts for other specs that assert straight off `request` the same way.
 */

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

  // The request succeeding at all is the point: a $convert with no onError throws on "TBD" and
  // takes the whole poll down with it, not just this one sprint's numbers.
  expect(response.status(), await response.text()).toBe(200);

  const sprints = await response.json();
  const sprint = sprints.find((s: { _id: string }) => s._id === String(ESTIMATE_SPRINT_ID));

  expect(sprint.taskCount).toBe(4);
  expect(sprint.doneCount).toBe(2);
  // 5 (a genuine number) + 3 (parsed from the string "3") + 0 ("TBD" can't convert) + 0 (no
  // value at all). A bare $sum would have ignored the string "3" instead of parsing it, landing
  // on 5 rather than 8 — the exact silently-wrong-looking-right number this task exists to avoid.
  expect(sprint.estimateTotal).toBe(8);
  // Only the two done-role tasks count here: the 5, and the "TBD" one, which still contributes 0.
  expect(sprint.estimateDone).toBe(5);
});
