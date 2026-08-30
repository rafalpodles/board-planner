import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-419. `claimNextTask` required assignee, `assignedBy` and the machine's owner to be one
 * person, and `assign_task` stamps `assignedBy` as the PM — so every task the PM assigned failed
 * that filter for ever. Silently: the claim is one `findOneAndUpdate`, a non-match and an empty
 * queue are the same 204, and the PM's own reply said `BP-x → @rafal` as though it had worked.
 *
 * rpo decided the PM's assignment is a real hand-over. This drives that end to end — the real chat,
 * the real agent loop, the real tool, the real claim route, the real board — because the defect
 * lived precisely in the seam between the tool that writes `assignedBy` and the filter that reads
 * it, and neither half is wrong on its own.
 *
 * Only the model is replaced (`e2e/openrouter-stub.mjs`), and what it "decides" travels inside the
 * message the test types. So nothing here asserts on the reply's text: the directive is on screen
 * too, and an assertion over rendered words would be matching this file's own.
 */

test.beforeEach(seed);

const APPROVED = "todo";
const ACTIVE = "in_progress";
const REMOTE = "e2e-owner/e2e-repo";
const RUNNABLE = { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [] };
const AGENT_ID = new mongoose.Types.ObjectId();

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let nextNumber = 700;

/** A task in the approved column naming an agent — everything the claim wants except the hand-over */
async function addTask(over: Record<string, unknown> = {}): Promise<{ id: mongoose.Types.ObjectId; number: number }> {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const taskNumber = nextNumber++;
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber,
    title: `handover ${taskNumber}`,
    description: "",
    priority: "medium",
    category: "user-story",
    status: APPROVED,
    assignee: null,
    assignedBy: null,
    agent: AGENT_ID,
    checklist: [],
    blockedBy: [],
    watchers: [],
    relations: [],
    linkedPRs: [],
    customFieldValues: {},
    execution: { runId: "", workerId: "", attempts: 0, startedAt: null, lastError: "" },
    order: 0,
    createdBy: ADMIN_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  return { id: _id, number: taskNumber };
}

const read = async (id: mongoose.Types.ObjectId) =>
  (await (await db()).collection("tasks").findOne({ _id: id }))!;

/** Everything `verdictFor` wants before this machine may claim, plus a project workers may run */
test.beforeEach(async () => {
  const handle = await db();
  // The block catalog is written at server BOOT, and seed() empties the database — so by the second
  // test of a run it is gone, and a missing block refuses the claim for a reason that has nothing
  // to do with who assigned what.
  await handle.collection("agentblocks").updateOne(
    { key: "implement" },
    { $set: { key: "implement", kind: "step", name: "Implement", description: "", prompt: "make the change", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false, builtIn: true } },
    { upsert: true }
  );
  await handle.collection("agents").updateOne(
    { _id: AGENT_ID },
    { $set: { _id: AGENT_ID, name: "The owner's own", description: "", scope: "user", owner: ADMIN_ID, project: null, composition: RUNNABLE, builtIn: false } },
    { upsert: true }
  );
  await handle.collection("workers").updateOne(
    { _id: WORKER_ID },
    { $set: { owner: ADMIN_ID, repos: [{ remote: REMOTE, path: "/e2e/checkout" }], lastSeenAt: new Date() } }
  );
  await handle.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { githubRepo: REMOTE, "worker.enabled": true } }
  );
});

function claim(request: APIRequestContext, runId: string) {
  return request.post(`/api/projects/${PROJECT_ID}/tasks/claim`, {
    headers: {
      authorization: `Bearer ${WORKER_CREDENTIAL}`,
      "x-worker-id": String(WORKER_ID),
      "x-cp-protocol": "1",
    },
    data: { runId },
  });
}

/** Drives the real PM turn. The tool call it should make travels in the message, between << and >>. */
async function pmAssigns(page: Page, taskKey: string, username: string) {
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  const box = page.getByRole("textbox", { name: /message/i });
  await expect(box).toBeVisible();
  const directive = { name: "assign_task", arguments: { taskKey, username } };
  await box.fill(`please hand this over <<${JSON.stringify(directive)}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The turn is done when the tool's action has been recorded on the stored message — the reply's
  // text is this file's own words coming back, so it is no evidence of anything.
  await expect
    .poll(async () => {
      const messages = await (await db()).collection("pmmessages").find({}).toArray();
      return messages.flatMap((m) => (m.actions ?? []) as { summary: string }[]).length;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const messages = await (await db()).collection("pmmessages").find({}).toArray();
  return messages.flatMap((m) => (m.actions ?? []) as { tool: string; summary: string }[]);
}

const pmUser = async () => (await db()).collection("users").findOne({ username: "pm" });

test("a task the PM assigned is claimed by the machine, and the board shows the run", async ({
  page,
  request,
}) => {
  const task = await addTask();
  await signIn(page, "admin");

  const actions = await pmAssigns(page, `${PROJECT_KEY}-${task.number}`, "admin");
  expect(actions.map((a) => a.tool)).toContain("assign_task");

  await test.step("the record stays honest about who assigned it", async () => {
    const stored = await read(task.id);
    expect(String(stored.assignee)).toBe(String(ADMIN_ID));
    // Not rewritten to the assignee: the activity log and the Agent row both read this field, and
    // the PM stamping itself as the assignee's own act would be a lie in the record
    expect(String(stored.assignedBy)).toBe(String((await pmUser())!._id));
  });

  await test.step("and the machine takes it", async () => {
    const claimed = await claim(request, "run-pm-handover");

    expect(claimed.status(), await claimed.text()).toBe(200);
    expect(String((await claimed.json())._id)).toBe(String(task.id));
    expect((await read(task.id)).status).toBe(ACTIVE);
  });

  await test.step("and the board shows it in the active column", async () => {
    await page.goto(`/projects/${PROJECT_KEY}`);
    // Scoped to the active column rather than found anywhere on the board: the card being on
    // screen says nothing — it was on screen before the claim too, one column to the left.
    const active = page.getByTestId(`column-${ACTIVE}`);
    await expect(active.locator(`a[href*="/tasks/${task.number}"]`)).toBeVisible();
    await expect(
      page.getByTestId(`column-${APPROVED}`).locator(`a[href*="/tasks/${task.number}"]`)
    ).toHaveCount(0);
  });
});

/**
 * The control, and the reason this change is "the PM is not somebody else" rather than "the consent
 * model was dropped". Without it, everything above reads identically to having deleted the guard.
 */
test("a task another person assigned is still refused, in the same queue", async ({ request }) => {
  const proposed = await addTask({ assignee: ADMIN_ID, assignedBy: MEMBER_ID });

  const claimed = await claim(request, "run-proposal");

  expect(claimed.status(), await claimed.text()).toBe(204);
  expect((await read(proposed.id)).status).toBe(APPROVED);
});

test("the PM says so when the hand-over it just made cannot complete", async ({ page }) => {
  // Everything else in place; the one thing missing is the choice that hands work to a machine
  const task = await addTask({ agent: null });
  await signIn(page, "admin");

  const actions = await pmAssigns(page, `${PROJECT_KEY}-${task.number}`, "admin");

  // "no agent" appears nowhere in what this test types, so this is the product's own sentence
  const summary = actions.find((a) => a.tool === "assign_task")?.summary ?? "";
  expect(summary).toContain(`${PROJECT_KEY}-${task.number} → @admin`);
  expect(summary).toMatch(/no agent is named on it/);
});

test("and says so when the project is not enabled for workers at all", async ({ page }) => {
  // The other half of "not every hand-over completes": the task is perfect, the instance is not.
  await (await db()).collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { "worker.enabled": false } }
  );
  const task = await addTask();
  await signIn(page, "admin");

  const actions = await pmAssigns(page, `${PROJECT_KEY}-${task.number}`, "admin");

  const summary = actions.find((a) => a.tool === "assign_task")?.summary ?? "";
  expect(summary).toMatch(/not enabled for workers/);
});
