import { describe, it, expect } from "vitest";
import { accountExport } from "./account-export";

const ME = "6a9d0f0b5d781bded2cb975a";
const PROJECT = "6a9d0f0b5d781bded2cb9801";
const TASK = "6a9d0f0b5d781bded2cb9901";

function rows(list: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const step of ["select", "sort"]) chain[step] = () => chain;
  chain.lean = async () => list;
  return chain;
}

function database(overrides: Record<string, unknown[]> = {}) {
  const served: Record<string, unknown[]> = {
    Grant: [{ object: PROJECT, relation: "owner", createdAt: "2026-01-01" }],
    Identity: [{ provider: "google", email: "jan@example.com", lastUsedAt: null, linkedAt: "2026-02-01", subject: "g-secret-subject", issuer: "https://accounts.google.com" }],
    ApiToken: [{ name: "ci", prefix: "cp_ab12", createdAt: "2026-03-01", lastUsedAt: null, tokenHash: "never-exported" }],
    Task: [{ _id: TASK, project: PROJECT, taskNumber: 7, title: "Mine", description: "d", status: "todo", createdAt: "2026-04-01" }],
    Comment: [{ task: TASK, body: "hello", createdAt: "2026-05-01" }],
    PmMessage: [{ project: PROJECT, role: "user", content: "plan it", createdAt: "2026-06-01" }],
    Notification: [{ type: "mentioned", title: "x mentioned you", body: "", createdAt: "2026-07-01" }],
    Project: [{ _id: PROJECT, key: "BP", name: "Board Planner" }],
    ...overrides,
  };
  const model = (name: string) => ({
    find: () => rows(served[name] ?? []),
    findById: () => ({
      lean: async () => ({
        username: "jan",
        fullName: "Jan Kowalski",
        email: "jan@example.com",
        role: "member",
        password: "bcrypt-hash-never-exported",
        notifications: { chat: { kind: "slack", webhookUrl: "https://hooks.slack.com/services/SECRET" } },
      }),
    }),
  });
  return new Proxy({}, { get: (_t, name: string) => model(name) }) as never;
}

describe("a person's own export", () => {
  it("holds what they wrote and were given, with board keys instead of ids", async () => {
    const data = await accountExport(database(), { _id: ME });

    expect(data.account).toMatchObject({ username: "jan", fullName: "Jan Kowalski", email: "jan@example.com", personalChat: "slack" });
    expect(data.boardAccess).toEqual([{ board: "BP", relation: "owner", since: "2026-01-01" }]);
    expect(data.comments).toEqual([{ task: "BP-7", createdAt: "2026-05-01", body: "hello" }]);
    expect(data.tasksCreated).toMatchObject([{ key: "BP-7", title: "Mine" }]);
    expect(data.pmMessages).toMatchObject([{ board: "BP", role: "user", content: "plan it" }]);
    expect(data.notifications).toHaveLength(1);
  });

  it("never carries a password hash, a token hash, a provider's subject or a webhook address", async () => {
    const text = JSON.stringify(await accountExport(database(), { _id: ME }));

    for (const secret of ["bcrypt-hash-never-exported", "never-exported", "g-secret-subject", "hooks.slack.com", "SECRET"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("names a board it cannot resolve by its id rather than dropping the row", async () => {
    const data = await accountExport(database({ Project: [] }), { _id: ME });
    expect(data.boardAccess[0].board).toBe(PROJECT);
    expect(data.comments[0].task).toBe(`?-7`);
  });
});
