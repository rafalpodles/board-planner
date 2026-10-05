import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { API_TOKEN, E2E_MONGODB_URI, PROJECT_ID, SIBLING_TASK_ID, seed } from "./seed";

const ADMIN = { authorization: `Bearer ${API_TOKEN}` };

test.beforeEach(async () => {
  await seed();
});

// BP-890 review: the wall reads paths, never values, so a column whose id is "organisation" still
// takes a task — the status change writes that id through an update pipeline
test("a task moves into a column called Organisation", async ({ request }) => {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    await mongoose.connection.db!.collection("projects").updateOne(
      { _id: PROJECT_ID },
      { $push: { columns: { _id: new mongoose.Types.ObjectId(), id: "organisation", label: "Organisation", color: "#888888", order: 7 } } } as never
    );
  } finally {
    await mongoose.disconnect();
  }

  const moved = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/status`, {
    headers: ADMIN,
    data: { status: "organisation" },
  });

  expect(moved.status(), await moved.text()).toBe(200);
  expect((await moved.json()).status).toBe("organisation");
});
