import { describe, it, expect, vi, beforeEach } from "vitest";
import { memoryDb } from "./memory-db-test-store";

const accessibleProjectIds = vi.fn();
vi.mock("@/lib/grants", () => ({ accessibleProjectIds }));

const { accountExport } = await import("./account-export");

const JAN = "6a9d0f0b5d781bded2cb975a";
const OLA = "6a9d0f0b5d781bded2cb975b";
const OPEN = "6a9d0f0b5d781bded2cb9801";
const CLOSED = "6a9d0f0b5d781bded2cb9802";
const ME = { _id: JAN, role: "member" } as never;

function database() {
  return memoryDb({
    User: [
      {
        _id: JAN,
        username: "jan",
        fullName: "Jan Kowalski",
        email: "jan@example.com",
        role: "member",
        password: "bcrypt-hash-never-exported",
        notifications: { chat: { kind: "slack", webhookUrl: "https://hooks.slack.com/services/SECRET" } },
      },
      { _id: OLA, username: "ola", fullName: "Ola Nowak", email: "ola@example.com" },
    ],
    Grant: [
      { subject: JAN, object: OPEN, relation: "owner", createdAt: "2026-01-01" },
      { subject: OLA, object: OPEN, relation: "member", createdAt: "2026-01-02" },
    ],
    Identity: [
      { user: JAN, provider: "google", email: "jan@example.com", subject: "g-secret-subject", linkedAt: "2026-02-01" },
      { user: OLA, provider: "github", email: "ola@example.com", subject: "gh-other" },
    ],
    ApiToken: [
      { user: JAN, name: "ci", prefix: "cp_ab12", tokenHash: "never-exported", createdAt: "2026-03-01" },
      { user: OLA, name: "olas-token", prefix: "cp_zz99", tokenHash: "other" },
    ],
    Task: [
      { _id: "t1", createdBy: JAN, project: OPEN, taskNumber: 7, title: "Mine", description: "d", status: "todo", createdAt: "2026-04-01" },
      { _id: "t2", createdBy: OLA, project: OPEN, taskNumber: 8, title: "Olas secret plan", description: "x", status: "todo" },
      { _id: "t3", createdBy: JAN, project: CLOSED, taskNumber: 2, title: "Now confidential", description: "edited by others", status: "todo", createdAt: "2026-04-02" },
    ],
    Comment: [
      { task: "t1", author: JAN, body: "hello", createdAt: "2026-05-01" },
      { task: "t1", author: OLA, body: "olas comment", createdAt: "2026-05-02" },
    ],
    PmMessage: [
      { project: OPEN, role: "user", content: "plan it", triggeredBy: JAN, createdAt: "2026-06-01" },
      { project: OPEN, role: "user", content: "olas question", triggeredBy: OLA, createdAt: "2026-06-02" },
    ],
    Notification: [
      { recipient: JAN, type: "mentioned", title: "x mentioned you", body: "", createdAt: "2026-07-01" },
      { recipient: OLA, type: "mentioned", title: "for ola", body: "", createdAt: "2026-07-02" },
    ],
    Project: [
      { _id: OPEN, key: "BP", name: "Open" },
      { _id: CLOSED, key: "SEC", name: "Closed" },
    ],
  });
}

beforeEach(() => accessibleProjectIds.mockResolvedValue([OPEN]));

describe("a person's own export", () => {
  it("holds what they wrote and were given, with board keys instead of ids", async () => {
    const data = await accountExport(database().db, ME);

    expect(data.account).toMatchObject({ username: "jan", fullName: "Jan Kowalski", email: "jan@example.com", personalChat: "slack" });
    expect(data.boardAccess).toEqual([{ board: "BP", relation: "owner", since: "2026-01-01" }]);
    expect(data.comments).toEqual([{ task: "BP-7", createdAt: "2026-05-01", body: "hello" }]);
    expect(data.pmMessages).toEqual([expect.objectContaining({ board: "BP", content: "plan it" })]);
    expect(data.notifications).toEqual([expect.objectContaining({ title: "x mentioned you" })]);
    expect(data.signInProviders).toEqual([expect.objectContaining({ provider: "google" })]);
    expect(data.apiTokens).toEqual([expect.objectContaining({ name: "ci", prefix: "cp_ab12" })]);
  });

  it("holds nobody else's: not another person's comments, messages, tokens, providers or tasks", async () => {
    const text = JSON.stringify(await accountExport(database().db, ME));
    for (const theirs of ["olas comment", "olas question", "olas-token", "gh-other", "Olas secret plan", "for ola", "ola@example.com", "Ola Nowak"]) {
      expect(text).not.toContain(theirs);
    }
  });

  it("never carries a password hash, a token hash, a provider's subject or a webhook address", async () => {
    const text = JSON.stringify(await accountExport(database().db, ME));
    for (const secret of ["bcrypt-hash-never-exported", "never-exported", "g-secret-subject", "hooks.slack.com", "SECRET"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("shows a task on a board they no longer reach only as made by them, not what it says now", async () => {
    const data = await accountExport(database().db, ME);
    expect(data.tasksCreated).toEqual([
      { key: "BP-7", title: "Mine", description: "d", status: "todo", createdAt: "2026-04-01" },
      { key: "SEC-2", createdAt: "2026-04-02" },
    ]);
  });

  it("shows everything they created when they reach every board", async () => {
    accessibleProjectIds.mockResolvedValue(null);
    const data = await accountExport(database().db, ME);
    expect(data.tasksCreated[1]).toMatchObject({ key: "SEC-2", title: "Now confidential" });
  });

  it("names a board it cannot resolve by its id rather than dropping the row", async () => {
    const { db, store } = database();
    store.Project = [];
    const data = await accountExport(db, ME);
    expect(data.boardAccess[0].board).toBe(OPEN);
    expect(data.comments[0].task).toBe("?-7");
  });
});
