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
      { project: CLOSED, role: "user", content: "what I asked", triggeredBy: JAN, createdAt: "2026-06-03" },
      { project: CLOSED, role: "assistant", content: "a summary of the closed board", triggeredBy: JAN, createdAt: "2026-06-04" },
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
    Session: [
      { user: JAN, tokenHash: "session-hash-never-exported", userAgent: "Firefox", ip: "203.0.113.5", createdAt: "2026-08-01", lastUsedAt: "2026-08-02", expiresAt: "2026-09-01" },
      { user: OLA, tokenHash: "other", userAgent: "OlasSafari", ip: "198.51.100.9", createdAt: "2026-08-01" },
    ],
    OAuthConsent: [
      { user: JAN, ticketHash: "ticket-hash-never-exported", clientId: "claude", redirectUri: "https://claude.example/cb", codeChallenge: "challenge-never-exported", scope: "mcp", createdAt: "2026-08-03", expiresAt: "2026-08-03" },
      { user: OLA, ticketHash: "other-ticket", clientId: "olas-client", scope: "mcp" },
    ],
    ActivityLog: [
      { user: JAN, task: "t1", action: "updated", field: "title", oldValue: "Old", newValue: "Mine", createdAt: "2026-04-03" },
      { user: JAN, task: "t3", action: "updated", field: "description", oldValue: "others' text", newValue: "my text", createdAt: "2026-04-04" },
      { user: OLA, task: "t1", action: "updated", field: "title", oldValue: "Mine", newValue: "Olas retitle", createdAt: "2026-04-05" },
    ],
    Agent: [
      { _id: "a1", scope: "user", owner: JAN, name: "Jan's refactorer", description: "mine", composition: { analysis: ["scan"], implementation: [{ key: "write", params: { n: 1 } }] }, createdAt: "2026-09-01" },
      { _id: "a2", scope: "user", owner: OLA, name: "Olas agent", description: "", composition: {} },
      { _id: "a3", scope: "global", owner: null, name: "Default", description: "", composition: {} },
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
    expect(data.pmMessages.map((m) => m.content)).toEqual(["plan it", "what I asked"]);
    expect(data.notifications).toEqual([expect.objectContaining({ title: "x mentioned you" })]);
    expect(data.signInProviders).toEqual([expect.objectContaining({ provider: "google" })]);
    expect(data.apiTokens).toEqual([expect.objectContaining({ name: "ci", prefix: "cp_ab12" })]);
  });

  it("holds nobody else's: not another person's comments, messages, tokens, providers or tasks", async () => {
    const text = JSON.stringify(await accountExport(database().db, ME));
    for (const theirs of ["olas comment", "olas question", "olas-token", "gh-other", "Olas secret plan", "for ola", "ola@example.com", "Ola Nowak", "OlasSafari", "198.51.100.9", "olas-client", "Olas retitle", "Olas agent"]) {
      expect(text).not.toContain(theirs);
    }
  });

  it("never carries a password hash, a token hash, a provider's subject or a webhook address", async () => {
    const text = JSON.stringify(await accountExport(database().db, ME));
    for (const secret of ["bcrypt-hash-never-exported", "never-exported", "g-secret-subject", "hooks.slack.com", "SECRET", "claude.example", "challenge"]) {
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

  it("keeps the assistant's replies from a board they no longer reach out, and what they asked in", async () => {
    const text = JSON.stringify(await accountExport(database().db, ME));
    expect(text).toContain("what I asked");
    expect(text).not.toContain("a summary of the closed board");
  });

  it("lists their sessions, consents, task changes and personal agents, and nobody's global or other personal agents", async () => {
    const data = await accountExport(database().db, ME);

    expect(data.sessions).toEqual([
      { userAgent: "Firefox", ip: "203.0.113.5", signedInAt: "2026-08-01", lastUsedAt: "2026-08-02", expiresAt: "2026-09-01" },
    ]);
    expect(data.consents).toEqual([{ client: "claude", scope: "mcp", grantedAt: "2026-08-03", expiresAt: "2026-08-03" }]);
    expect(data.personalAgents).toEqual([
      {
        name: "Jan's refactorer",
        description: "mine",
        createdAt: "2026-09-01",
        steps: {
          analysis: [{ key: "scan" }],
          implementation: [{ key: "write", params: { n: 1 } }],
          verification: [],
          delivery: [],
        },
      },
    ]);
    expect(JSON.stringify(data.personalAgents)).not.toContain("Default");
  });

  it("shows what they changed on a board they reach, and only that they changed it on one they no longer reach", async () => {
    const data = await accountExport(database().db, ME);

    expect(data.activity).toEqual([
      { task: "BP-7", action: "updated", field: "title", createdAt: "2026-04-03", from: "Old", to: "Mine" },
      { task: "SEC-2", action: "updated", field: "description", createdAt: "2026-04-04" },
    ]);
    expect(JSON.stringify(data.activity)).not.toContain("others' text");
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
