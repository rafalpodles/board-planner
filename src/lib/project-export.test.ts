import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose, { Types } from "mongoose";
import "@/models/all";
import type { ScopedDb } from "./db-scope";

const { organisationExists, uploadRows } = vi.hoisted(() => ({
  organisationExists: vi.fn(),
  uploadRows: vi.fn(),
}));

vi.mock("@/models/organisation", () => ({ Organisation: { exists: organisationExists } }));
vi.mock("./upload-ownership", () => ({
  UPLOAD_BUCKET: "uploads",
  organisationUploads: () => ({ rows: uploadRows }),
}));

import { PROJECT_EXPORT_FORMAT, ProjectExportCutShortError, projectExport } from "./project-export";

type Row = Record<string, unknown>;
const id = () => new Types.ObjectId();

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, want]) => {
    if (key === "$and") return (want as Row[]).every((part) => matches(row, part));
    if (want && typeof want === "object" && "$in" in want) return (want as { $in: unknown[] }).$in.map(String).includes(String(row[key]));
    if (want && typeof want === "object" && "$gt" in want) return String(row[key]) > String((want as { $gt: unknown }).$gt);
    return String(row[key]) === String(want);
  });
}

function world() {
  const organisation = id();
  const mine = id();
  const other = id();
  const alice = id();
  const bob = id();
  const stranger = id();
  const myTask = id();
  const otherTask = id();
  const store: Record<string, Row[]> = {
    Project: [
      { _id: mine, key: "MINE", name: "Mine", owner: alice, githubToken: "enc:v3:k:aaa", webhooks: [{ name: "zap", url: "https://hooks/secret" }] },
      { _id: other, key: "OTHER", name: "Other", owner: stranger },
    ],
    Task: [
      { _id: myTask, project: mine, title: "Mine", assignee: bob, createdBy: alice },
      { _id: otherTask, project: other, title: "Theirs", assignee: stranger },
    ],
    Comment: [
      { _id: id(), task: myTask, author: alice, body: "mine", reactions: [{ emoji: "x", user: bob }] },
      { _id: id(), task: otherTask, author: stranger, body: "theirs" },
    ],
    ActivityLog: [
      { _id: id(), task: myTask, user: alice, action: "created" },
      { _id: id(), task: otherTask, user: stranger, action: "created" },
    ],
    Sprint: [
      { _id: id(), project: mine, name: "S1" },
      { _id: id(), project: other, name: "S2" },
    ],
    ProjectAuditLog: [
      { _id: id(), project: mine, user: alice, action: "settings_updated" },
      { _id: id(), project: other, user: stranger, action: "settings_updated" },
    ],
    Agent: [
      { _id: id(), scope: "project", project: mine, name: "Mine agent" },
      { _id: id(), scope: "project", project: other, name: "Their agent" },
      { _id: id(), scope: "global", project: null, name: "Global agent" },
    ],
    AgentRun: [
      { _id: id(), project: mine },
      { _id: id(), project: other },
    ],
    PmMessage: [
      { _id: id(), project: mine, role: "user", content: "mine" },
      { _id: id(), project: other, role: "user", content: "theirs" },
    ],
    Grant: [
      { _id: id(), objectType: "project", object: mine, subject: bob, createdBy: alice },
      { _id: id(), objectType: "project", object: other, subject: stranger },
    ],
    User: [
      { _id: alice, username: "alice", fullName: "Alice A", email: "alice@example.com", password: "x" },
      { _id: bob, username: "bob", fullName: "Bob B", email: "bob@example.com" },
      { _id: stranger, username: "stranger", fullName: "Stranger", email: "s@example.com" },
    ],
  };
  const asked: { model: string; filter: Row }[] = [];
  const model = (name: string) => ({
    find(filter: Row) {
      asked.push({ model: name, filter });
      let limit = Infinity;
      const chain = {
        select: () => chain,
        sort: () => chain,
        limit: (n: number) => {
          limit = n;
          return chain;
        },
        lean: async () =>
          (store[name] ?? [])
            .filter((row) => matches(row, filter))
            .sort((a, b) => String(a._id).localeCompare(String(b._id)))
            .slice(0, limit)
            .map((row) => ({ ...row })),
      };
      return chain;
    },
    exists: async (filter: Row) => ((store[name] ?? []).find((row) => matches(row, filter)) ? { _id: 1 } : null),
  });
  const db = new Proxy({ organisation }, { get: (target, key) => (key in target ? target[key as "organisation"] : model(String(key))) }) as unknown as ScopedDb;
  return { db, store, asked, mine, other, myTask, otherTask, alice, bob, stranger };
}

async function exported(db: ScopedDb, project: Types.ObjectId) {
  const lines: string[] = [];
  for await (const line of projectExport(db, project)) lines.push(line);
  const rows = lines.map((line) => mongoose.mongo.BSON.EJSON.parse(line) as { collection?: string; document?: Row } & Row);
  return { header: rows[0], rows: rows.slice(1) as { collection: string; document: Row }[], text: lines.join("") };
}

describe("exporting one project (BP-1011)", () => {
  beforeEach(() => {
    organisationExists.mockReset().mockResolvedValue({ _id: 1 });
    uploadRows.mockReset().mockImplementation(async function* () {});
  });

  it("holds the project's own rows in every collection and nothing of another project", async () => {
    const { db, mine } = world();
    const { header, rows, text } = await exported(db, mine);

    expect(header).toMatchObject({ format: PROJECT_EXPORT_FORMAT, version: 1 });
    const by = (collection: string) => rows.filter((row) => row.collection === collection).map((row) => row.document);
    expect(by("Project")).toHaveLength(1);
    for (const collection of ["Task", "Comment", "ActivityLog", "Sprint", "ProjectAuditLog", "Agent", "AgentRun", "PmMessage", "Grant"]) {
      expect(by(collection), collection).toHaveLength(1);
    }
    expect(by("Agent")[0].name).toBe("Mine agent");
    expect(header.collections).toEqual(expect.arrayContaining(["Project", "Task", "Comment", "ActivityLog", "Sprint", "User", "uploads.files", "uploads.chunks"]));
    for (const leak of ["OTHER", "Theirs", "theirs", "Their agent", "Global agent", "stranger", "Stranger"]) expect(text, leak).not.toContain(leak);
  });

  it("asks every collection about this project only, comments and history through its tasks", async () => {
    const { db, asked, mine, myTask } = world();
    await exported(db, mine);

    const filterOf = (model: string) => asked.filter((call) => call.model === model).map((call) => call.filter);
    expect(filterOf("Project")).toEqual([{ _id: mine }]);
    for (const model of ["Sprint", "Task", "ProjectAuditLog", "AgentRun", "PmMessage"]) expect(filterOf(model), model).toEqual([{ project: mine }]);
    expect(filterOf("Agent")).toEqual([{ scope: "project", project: mine }]);
    expect(filterOf("Grant")).toEqual([{ objectType: "project", object: mine }]);
    for (const model of ["Comment", "ActivityLog"]) expect(filterOf(model), model).toEqual([{ task: { $in: [myTask] } }]);
    expect(uploadRows).toHaveBeenCalledWith(mine);
  });

  it("keeps secrets out of the rows, as the organisation export does", async () => {
    const { db, mine } = world();
    const { rows, text } = await exported(db, mine);

    const project = rows.find((row) => row.collection === "Project")!.document;
    expect(project).not.toHaveProperty("githubToken");
    expect(project.webhooks).toEqual([{ name: "zap" }]);
    expect(text).not.toMatch(/enc:v3|hooks\/secret|password/);
  });

  it("names the people the rows point at, by user name and full name only", async () => {
    const { db, mine, alice, bob } = world();
    const { header, rows, text } = await exported(db, mine);

    const people = rows.filter((row) => row.collection === "User").map((row) => row.document);
    expect(people.map((person) => person.username).sort()).toEqual(["alice", "bob"]);
    for (const person of people) expect(Object.keys(person).sort()).toEqual(["_id", "fullName", "username"]);
    expect(people.map((person) => String(person._id)).sort()).toEqual([String(alice), String(bob)].sort());
    expect(header.reduced).toEqual({ User: ["username", "fullName"] });
    expect(text).not.toContain("@example.com");
  });

  it("reads comments in bounded groups of tasks", async () => {
    const { db, store, asked, mine } = world();
    for (let n = 0; n < 1500; n++) store.Task.push({ _id: id(), project: mine, title: `t${n}` });
    await exported(db, mine);

    const comments = asked.filter((call) => call.model === "Comment").map((call) => (call.filter.task as { $in: unknown[] }).$in.length);
    expect(comments.length).toBeGreaterThan(1);
    expect(Math.max(...comments)).toBeLessThanOrEqual(1000);
    expect(comments.reduce((sum, count) => sum + count, 0)).toBe(1501);
  });

  it("stops rather than ending cleanly when the project is deleted part-way", async () => {
    const { db, store, mine } = world();
    const run = projectExport(db, mine);
    await run.next();
    store.Project = [];
    await expect((async () => { for await (const _ of run) void _; })()).rejects.toBeInstanceOf(ProjectExportCutShortError);
  });
});
