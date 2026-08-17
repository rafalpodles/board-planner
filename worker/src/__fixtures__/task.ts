import { ClaimedTask } from "../types.js";

/**
 * A claimed task, whole. Every test file used to write its own literal, and every one of them was
 * missing a required field — nothing type-checked them (`worker/tsconfig.json` excludes tests), so
 * the next field added to ClaimedTask broke eight fixtures silently.
 *
 * The agent here is the shortest runnable one: write, then send. A test that cares about the
 * sequence passes its own.
 */
export function claimedTask(over: Partial<ClaimedTask> = {}): ClaimedTask {
  return {
    taskId: "t1",
    projectId: "CP",
    taskKey: "CP-158",
    taskNumber: 158,
    title: "Add a thing",
    description: "body",
    acceptanceCriteria: [],
    attempts: 1,
    runId: "run-1",
    agent: {
      agentId: "a1",
      name: "Default",
      sequence: [
        {
          key: "implement",
          kind: "step",
          name: "Implement",
          prompt: "make the change",
          capability: "edit",
        },
        { key: "push", kind: "step", name: "Push", deterministic: true },
      ],
    },
    ...over,
  };
}
