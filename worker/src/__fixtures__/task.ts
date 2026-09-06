import { ClaimedTask } from "../types.js";

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
