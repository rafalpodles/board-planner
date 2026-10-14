import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import { E2E_MONGODB_URI, seed } from "./seed";

/**
 * BP-877. The Insights page is BP-879, so this route has no click-through surface yet: the e2e is
 * the real server answering for a project whose history was written by the real status route,
 * checked against the times the store kept for those very moves.
 */

const ORGANISATION_ID = new mongoose.Types.ObjectId("000000000000000000000001");

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
});

test.afterEach(async () => {
  await (await db()).collection("organisations").deleteOne({ _id: ORGANISATION_ID });
  await mongoose.disconnect();
});

interface Board {
  projectId: string;
  taskIds: Map<string, string>;
}

async function boardWithHistory(request: APIRequestContext): Promise<Board> {
  const created = await request.post("/api/projects", { headers: ADMIN_AUTH, data: { name: "Insights", key: "INS" } });
  expect(created.status(), await created.text()).toBe(201);
  const { _id: projectId } = (await created.json()) as { _id: string };

  const qa = await request.post(`/api/projects/${projectId}/columns`, {
    headers: ADMIN_AUTH,
    data: { label: "QA", role: "review" },
  });
  expect(qa.status(), await qa.text()).toBe(201);

  const taskIds = new Map<string, string>();
  for (const title of ["straight", "reopened", "through-qa", "in-progress", "never-started"]) {
    const task = await request.post(`/api/projects/${projectId}/tasks`, {
      headers: ADMIN_AUTH,
      data: { title, status: "todo" },
    });
    expect(task.status(), await task.text()).toBe(201);
    taskIds.set(title, ((await task.json()) as { _id: string })._id);
  }

  const move = async (title: string, status: string) => {
    const res = await request.patch(`/api/projects/${projectId}/tasks/${taskIds.get(title)}/status`, {
      headers: ADMIN_AUTH,
      data: { status },
    });
    expect(res.status(), await res.text()).toBe(200);
  };

  await move("straight", "in_progress");
  await move("straight", "done");
  await move("reopened", "in_progress");
  await move("reopened", "done");
  await move("reopened", "in_progress");
  await move("reopened", "done");
  await move("through-qa", "in_progress");
  await move("through-qa", "qa");
  await move("through-qa", "done");
  await move("in-progress", "in_progress");

  const columns = await request.get(`/api/projects/${projectId}/columns`, { headers: ADMIN_AUTH });
  const withoutQa = ((await columns.json()) as { id: string }[]).filter((column) => column.id !== "qa");
  const removed = await request.put(`/api/projects/${projectId}/columns`, {
    headers: ADMIN_AUTH,
    data: { columns: withoutQa },
  });
  expect(removed.status(), await removed.text()).toBe(200);

  return { projectId, taskIds };
}

/** Lead and cycle time computed by hand from what the store kept, independently of the route. */
async function storedTimes({ taskIds }: Board, title: string) {
  const task = new mongoose.Types.ObjectId(taskIds.get(title));
  const handle = await db();
  const { createdAt } = (await handle.collection("tasks").findOne({ _id: task }))!;
  const rows = await handle
    .collection("activitylogs")
    .find({ task, action: "status_changed" })
    .sort({ createdAt: 1 })
    .toArray();
  const start = rows.find((row) => row.newValue === "in_progress")!.createdAt as Date;
  const finish = rows.filter((row) => row.newValue === "done").at(-1)!.createdAt as Date;
  return { lead: finish.getTime() - (createdAt as Date).getTime(), cycle: finish.getTime() - start.getTime() };
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const median = (values: number[]) => sorted(values)[1];
const p85 = (values: number[]) => {
  const [, middle, top] = sorted(values);
  return Math.round(middle + 0.7 * (top - middle));
};

test("figures equal a hand computation from the stored history, a reopened task and a deleted column included", async ({
  request,
}) => {
  await setPlan("pro");
  const board = await boardWithHistory(request);

  const response = await request.get(`/api/projects/${board.projectId}/insights?weeks=4`, { headers: ADMIN_AUTH });
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();

  const times = await Promise.all(["straight", "reopened", "through-qa"].map((title) => storedTimes(board, title)));
  expect(body.empty).toBe(false);
  expect(body.summary.throughput).toBe(3);
  expect(body.summary.leadTime).toMatchObject({
    count: 3,
    medianMs: median(times.map((t) => t.lead)),
    p85Ms: p85(times.map((t) => t.lead)),
  });
  expect(body.summary.cycleTime).toMatchObject({
    count: 3,
    medianMs: median(times.map((t) => t.cycle)),
    p85Ms: p85(times.map((t) => t.cycle)),
  });
  expect(body.weekly).toHaveLength(4);
  expect(body.weekly.at(-1).throughput).toBe(3);
  expect(body.excluded).toEqual({ noHistory: 0, gap: 0, startInferred: 0 });
  expect(body.agingWip.tasks.map((t: { title: string }) => t.title)).toEqual(["in-progress"]);
  expect(body).not.toHaveProperty("byEstimate");
});

test("a project with nothing finished answers an explicit empty state", async ({ request }) => {
  await setPlan("pro");
  const created = await request.post("/api/projects", { headers: ADMIN_AUTH, data: { name: "Quiet", key: "QUI" } });
  const { _id: projectId } = (await created.json()) as { _id: string };

  const response = await request.get(`/api/projects/${projectId}/insights`, { headers: ADMIN_AUTH });

  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ empty: true, summary: { throughput: 0, leadTime: null, cycleTime: null } });
  expect(JSON.stringify(body)).not.toContain("NaN");
});

test("402 on Free, 200 on Pro, and the velocity route answers the same on both", async ({ request }) => {
  await setPlan("free");
  const board = await boardWithHistory(request);

  const refused = await request.get(`/api/projects/${board.projectId}/insights`, { headers: ADMIN_AUTH });
  expect(refused.status(), await refused.text()).toBe(402);
  expect(await refused.json()).toMatchObject({ feature: "reports.insights", plan: "free" });
  const statsOnFree = await request.get(`/api/projects/${board.projectId}/stats`, { headers: ADMIN_AUTH });
  expect(statsOnFree.status()).toBe(200);

  await setPlan("pro");
  const answered = await request.get(`/api/projects/${board.projectId}/insights`, { headers: ADMIN_AUTH });
  expect(answered.status(), await answered.text()).toBe(200);
  const statsOnPro = await request.get(`/api/projects/${board.projectId}/stats`, { headers: ADMIN_AUTH });
  expect(await statsOnPro.json()).toEqual(await statsOnFree.json());
});

test("a member who cannot reach the project is refused before the plan is asked", async ({ request }) => {
  await setPlan("free");
  const created = await request.post("/api/projects", { headers: ADMIN_AUTH, data: { name: "Private", key: "PRI" } });
  const { _id: projectId } = (await created.json()) as { _id: string };

  const response = await request.get(`/api/projects/${projectId}/insights`, { headers: MEMBER_AUTH });

  expect(response.status(), await response.text()).toBe(403);
});

test("breaks figures down by the designated estimate field, read from the stored task", async ({ request }) => {
  await setPlan("pro");
  const created = await request.post("/api/projects", { headers: ADMIN_AUTH, data: { name: "Estimated", key: "EST" } });
  const { _id: projectId } = (await created.json()) as { _id: string };
  const fields = await request.post(`/api/projects/${projectId}/custom-fields`, {
    headers: ADMIN_AUTH,
    data: { name: "Points", fieldType: "number" },
  });
  expect(fields.status(), await fields.text()).toBe(201);
  const points = ((await fields.json()) as { _id: string; name: string }[]).find((f) => f.name === "Points")!;
  const designated = await request.put(`/api/projects/${projectId}`, {
    headers: ADMIN_AUTH,
    data: { estimateFieldId: points._id },
  });
  expect(designated.status(), await designated.text()).toBe(200);

  for (const [title, value] of [["three", 3], ["unestimated", null]] as const) {
    const task = await request.post(`/api/projects/${projectId}/tasks`, {
      headers: ADMIN_AUTH,
      data: { title, status: "todo", ...(value === null ? {} : { customFieldValues: { [points._id]: value } }) },
    });
    expect(task.status(), await task.text()).toBe(201);
    const { _id: taskId } = (await task.json()) as { _id: string };
    for (const status of ["in_progress", "done"]) {
      const moved = await request.patch(`/api/projects/${projectId}/tasks/${taskId}/status`, {
        headers: ADMIN_AUTH,
        data: { status },
      });
      expect(moved.status(), await moved.text()).toBe(200);
    }
  }

  const body = await (await request.get(`/api/projects/${projectId}/insights`, { headers: ADMIN_AUTH })).json();

  expect(body.byEstimate.field).toEqual({ id: points._id, name: "Points" });
  expect(Object.keys(body.byEstimate.values).sort()).toEqual(["3", "none"]);
  expect(body.byEstimate.values["3"].throughput).toBe(1);
});
