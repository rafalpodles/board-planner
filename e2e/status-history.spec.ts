import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, e2eDatabaseName } from "./seed";
import { scopedToDefaultOrganisation } from "../src/lib/db-scope";
import { logActivity } from "../src/lib/activity";
import { backfillActivityProjects } from "../src/lib/activity-project-backfill";
import { projectStatusHistories, statusChangeFilter, STATUS_CHANGE_SORT } from "../src/lib/status-history";
import { DEFAULT_ORGANISATION_ID } from "../src/lib/organisation-field";

/**
 * BP-876. What the unit tests cannot say: a backfill against a real collection, and that the query
 * the project-wide read runs is served by the index and not by a scan.
 */

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const DB = `${e2eDatabaseName().replace(/_e2e$/, "")}_statushistory_e2e`;
const oid = (hex: string) => new mongoose.Types.ObjectId(hex.padStart(24, "0"));
const P1 = oid("a1");
const P2 = oid("a2");
const T1 = oid("b1");
const T2 = oid("b2");
const T3 = oid("b3");
const T_GONE = oid("b9");
const day = (n: number) => new Date(Date.UTC(2026, 9, n));

const COLUMNS = [
  { id: "todo", label: "To do", role: "approved", order: 0 },
  { id: "doing", label: "Doing", role: "active", order: 1 },
  { id: "done", label: "Done", role: "done", order: 2 },
];

const col = (name: string) => mongoose.connection.db!.collection(name);
const org = { organisation: DEFAULT_ORGANISATION_ID };
const legacy = (task: mongoose.Types.ObjectId, newValue: string, at: Date, project?: mongoose.Types.ObjectId) => ({
  task,
  ...(project ? { project } : {}),
  action: "status_changed",
  field: "status",
  oldValue: "",
  newValue,
  createdAt: at,
  ...org,
});

async function dropOwnDatabase() {
  expect(mongoose.connection.db?.databaseName).toBe(DB);
  await mongoose.connection.dropDatabase();
}

test.beforeAll(async () => {
  await mongoose.disconnect();
  await mongoose.connect(E2E_MONGODB_URI, { dbName: DB, autoIndex: false, autoCreate: false });
});

test.afterAll(async () => {
  await dropOwnDatabase();
  await mongoose.disconnect();
});

test.beforeEach(async () => {
  await dropOwnDatabase();
  await col("projects").insertMany([
    { _id: P1, key: "AA", name: "First", columns: COLUMNS, ...org },
    { _id: P2, key: "BB", name: "Second", columns: COLUMNS, ...org },
  ]);
  await col("tasks").insertMany([
    { _id: T1, project: P1, taskNumber: 1, title: "one", status: "done", createdAt: day(1), ...org },
    { _id: T2, project: P2, taskNumber: 1, title: "two", status: "doing", createdAt: day(1), ...org },
    { _id: T3, project: P1, taskNumber: 2, title: "three", status: "done", createdAt: day(1), ...org },
  ]);
});

async function everyRow() {
  return JSON.stringify(await col("activitylogs").find({}).sort({ _id: 1 }).toArray());
}

async function seedLegacyRows() {
  await col("activitylogs").insertMany([
    legacy(T1, "doing", day(2)),
    legacy(T1, "done", day(4)),
    legacy(T2, "doing", day(3)),
    legacy(T_GONE, "done", day(5)),
    legacy(T3, "done", day(6), P1),
  ]);
}

test("a dry run says what it would fill and writes nothing", async () => {
  await seedLegacyRows();
  const before = await everyRow();

  const report = await backfillActivityProjects(mongoose.connection, { apply: false });

  expect(report).toEqual({ rowsMissing: 4, rowsFilled: 3, tasks: 3, orphanedTasks: 1, orphanedRows: 1 });
  expect(await everyRow()).toBe(before);
});

test("an apply gives each row its task's project, leaves the rows of a deleted task, and a rerun fills nothing", async () => {
  await seedLegacyRows();

  const first = await backfillActivityProjects(mongoose.connection, { apply: true });
  expect(first).toEqual({ rowsMissing: 4, rowsFilled: 3, tasks: 3, orphanedTasks: 1, orphanedRows: 1 });

  const projectOf = async (task: mongoose.Types.ObjectId) =>
    (await col("activitylogs").find({ task }).toArray()).map((row) => (row.project ? String(row.project) : null));
  expect(await projectOf(T1)).toEqual([String(P1), String(P1)]);
  expect(await projectOf(T2)).toEqual([String(P2)]);
  expect(await projectOf(T3)).toEqual([String(P1)]);
  expect(await projectOf(T_GONE)).toEqual([null]);

  const after = await everyRow();
  const second = await backfillActivityProjects(mongoose.connection, { apply: true });
  expect(second).toMatchObject({ rowsFilled: 0, tasks: 1, orphanedRows: 1 });
  expect(await everyRow()).toBe(after);
});

test("a row that already names a project keeps it, beside a row of the same task that did not", async () => {
  await col("activitylogs").insertMany([legacy(T2, "doing", day(3)), legacy(T2, "done", day(5), P1)]);

  await backfillActivityProjects(mongoose.connection, { apply: true });

  const rows = await col("activitylogs").find({ task: T2 }).sort({ createdAt: 1 }).toArray();
  expect(rows.map((row) => String(row.project))).toEqual([String(P2), String(P1)]);
});

test("logActivity writes the project it is given on the row", async () => {
  await logActivity(scopedToDefaultOrganisation(), P1, T1, null, "status_changed", "status", "todo", "doing");

  const [row] = await col("activitylogs").find({ task: T1 }).toArray();
  expect(String(row.project)).toBe(String(P1));
  expect(row).toMatchObject({ action: "status_changed", oldValue: "todo", newValue: "doing" });
});

test("the project-wide read is served by the {project, action, createdAt} index, in order, with no sort stage", async () => {
  await mongoose.model("ActivityLog").createIndexes();
  await seedLegacyRows();
  await backfillActivityProjects(mongoose.connection, { apply: true });

  const plan = await col("activitylogs")
    .find({ ...statusChangeFilter(P1), ...org })
    .sort(STATUS_CHANGE_SORT)
    .explain("queryPlanner");
  const winning = JSON.stringify(plan.queryPlanner.winningPlan);

  expect(winning).toContain('"stage":"IXSCAN"');
  expect(winning).toContain('"indexName":"project_1_action_1_createdAt_1"');
  expect(winning).not.toContain('"stage":"SORT"');
  expect(winning).not.toContain("COLLSCAN");
});

test("a project's histories come from its own rows, with a task that has none reported as no history", async () => {
  await col("activitylogs").insertMany([
    { ...legacy(T1, "doing", day(2), P1), oldValue: "todo" },
    { ...legacy(T1, "done", day(4), P1), oldValue: "doing" },
    { ...legacy(T2, "done", day(3), P2), oldValue: "doing" },
  ]);

  const histories = await projectStatusHistories(scopedToDefaultOrganisation(), String(P1));

  expect(histories.map((h) => [h.taskNumber, h.history.kind])).toEqual([
    [1, "recorded"],
    [2, "no-history"],
  ]);
  expect(histories[0].history).toMatchObject({ startedAt: day(2), finishedAt: day(4), endedIn: "done", gap: false });
});

test("a column the project no longer has leaves the task in the read, in a bucket of its own", async () => {
  await col("activitylogs").insertOne({ ...legacy(T1, "retired", day(2), P1), oldValue: "todo" });
  await col("tasks").updateOne({ _id: T1 }, { $set: { status: "retired" } });

  const [first] = await projectStatusHistories(scopedToDefaultOrganisation(), String(P1));

  expect(first.history).toMatchObject({ kind: "recorded", endedIn: "unknown", unknownColumns: ["retired"], finishedAt: null });
});
