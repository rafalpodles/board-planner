import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { MACHINE_FORCE_REFUSAL } from "@/lib/force-guard";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
import {
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  PROJECT_ID,
  SOURCE_COLUMN,
  TARGET_COLUMN,
  seed,
  storedExecution,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-694. `machineMayNotForce` is the rule that an unattended agent must not take work off a
 * machine, and it was defended only by unit tests with a mocked user. Here a real API token and a
 * real browser session send the same `force: true` to every door that consults it.
 */

const TASK_URL = `/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}`;

interface Door {
  name: string;
  deletes: boolean;
  send: (
    request: APIRequestContext,
    headers: Record<string, string>,
    force?: boolean
  ) => ReturnType<APIRequestContext["fetch"]>;
}

const DOORS: Door[] = [
  {
    name: "PATCH …/status",
    deletes: false,
    send: (request, headers, force = true) =>
      request.patch(`${TASK_URL}/status`, { headers, data: { status: TARGET_COLUMN.id, force } }),
  },
  {
    name: "PUT …/tasks/[taskId]",
    deletes: false,
    send: (request, headers, force = true) =>
      request.put(TASK_URL, { headers, data: { status: TARGET_COLUMN.id, force } }),
  },
  {
    name: "DELETE …/tasks/[taskId]",
    deletes: true,
    send: (request, headers, force = true) => request.delete(TASK_URL, { headers, data: { force } }),
  },
];

async function storedTask() {
  await mongoose.connect(E2E_MONGODB_URI);
  const task = await mongoose.connection.db!.collection("tasks").findOne({ _id: HELD_TASK_ID });
  await mongoose.disconnect();
  return task;
}

test.beforeEach(seed);

for (const door of DOORS) {
  test.describe(door.name, () => {
    test("an API token sending force is refused, and the run keeps the task", async ({ request }) => {
      const response = await door.send(request, ADMIN_AUTH);

      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ error: MACHINE_FORCE_REFUSAL });
      expect(await storedExecution(HELD_TASK_ID)).toMatchObject({ runId: "e2e-run-0001" });
      expect(await storedTask()).toMatchObject({ status: SOURCE_COLUMN.id });
    });

    // Without force the token meets the run's own 409, so the 403 above is about force alone
    test("the same token without force is told a machine holds the task", async ({ request }) => {
      const response = await door.send(request, ADMIN_AUTH, false);

      expect(response.status()).toBe(409);
      expect(await storedExecution(HELD_TASK_ID)).toMatchObject({ runId: "e2e-run-0001" });
    });

    // The control: the same request from a person's session goes through, so the refusal above is
    // about the credential and not about the request.
    test("a person's session sending the same force takes the task off the machine", async ({
      page,
    }) => {
      await signIn(page, "admin");
      const response = await door.send(page.request, SAME_ORIGIN);

      expect(response.status(), await response.text()).toBe(200);
      const task = await storedTask();
      if (door.deletes) {
        expect(task).toBeNull();
      } else {
        expect(task).toMatchObject({ status: TARGET_COLUMN.id });
        expect((await storedExecution(HELD_TASK_ID))?.runId).not.toBe("e2e-run-0001");
      }
    });
  });
}
