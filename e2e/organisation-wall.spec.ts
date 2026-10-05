import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, e2eDatabaseName } from "./seed";
import { scoped } from "../src/lib/db-scope";
import { acrossOrganisations } from "../src/lib/organisation-wall";
import { Task } from "../src/models/task";
import { User } from "../src/models/user";
import { Project } from "../src/models/project";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const DB = `${e2eDatabaseName().replace(/_e2e$/, "")}_wall_e2e`;
const ACME = new mongoose.Types.ObjectId("0000000000000000000000a1");
const GLOBEX = new mongoose.Types.ObjectId("0000000000000000000000b2");
const ACME_USER = new mongoose.Types.ObjectId("0000000000000000000a1001");
const GLOBEX_USER = new mongoose.Types.ObjectId("0000000000000000000b2001");
const ACME_PROJECT = new mongoose.Types.ObjectId("0000000000000000000a1002");
const ACME_TASK = new mongoose.Types.ObjectId("0000000000000000000a1003");
const GLOBEX_TASK = new mongoose.Types.ObjectId("0000000000000000000b2003");

const col = (name: string) => mongoose.connection.db!.collection(name);
const WALL = /names (no|another) organisation|reaches another collection/;

test.beforeEach(async () => {
  await mongoose.connect(E2E_MONGODB_URI, { dbName: DB, autoIndex: false, autoCreate: false });
  await mongoose.connection.dropDatabase();
  await col("users").insertMany([
    { _id: ACME_USER, organisation: ACME, username: "boss", fullName: "Acme Boss", role: "admin", kind: "human" },
    { _id: GLOBEX_USER, organisation: GLOBEX, username: "boss", fullName: "Globex Boss", role: "admin", kind: "human" },
  ]);
  await col("projects").insertOne({ _id: ACME_PROJECT, organisation: ACME, name: "Acme Rockets", key: "SAME", createdBy: ACME_USER, taskCounter: 1 });
  await col("tasks").insertMany([
    { _id: ACME_TASK, organisation: ACME, project: ACME_PROJECT, taskNumber: 1, title: "Acme secret", assignee: ACME_USER, createdBy: ACME_USER },
    { _id: GLOBEX_TASK, organisation: GLOBEX, project: ACME_PROJECT, taskNumber: 1, title: "Globex secret", assignee: GLOBEX_USER, createdBy: GLOBEX_USER },
  ]);
});

test.afterEach(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("the scoped db still reads, writes, counts, aggregates and populates within its organisation", async () => {
  const db = scoped(ACME);

  expect((await db.Task.find({}).lean()).map((task) => task.title)).toEqual(["Acme secret"]);
  expect(await db.Task.countDocuments({})).toBe(1);
  expect((await db.Task.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]))[0].n).toBe(1);
  await db.Task.updateOne({ _id: ACME_TASK }, { $set: { title: "Acme renamed" } });
  const populated = await db.Task.findOne({ _id: ACME_TASK }).populate("assignee", "fullName").lean();
  expect((populated!.assignee as unknown as { fullName: string }).fullName).toBe("Acme Boss");
});

test("a populate never reaches a document of another organisation, even one the row points at", async () => {
  await col("tasks").updateOne({ _id: ACME_TASK }, { $set: { assignee: GLOBEX_USER } });

  const task = await scoped(ACME).Task.findOne({ _id: ACME_TASK }).populate({ path: "assignee", select: "fullName" }).lean();

  expect(task!.assignee).toBeNull();
});

test("a document loaded through the scoped db saves, updates and deletes itself", async () => {
  const task = await scoped(ACME).Task.findOne({ _id: ACME_TASK });
  task!.title = "Saved by the document";
  await task!.save();
  await task!.updateOne({ $set: { title: "Updated by the document" } });
  expect((await col("tasks").findOne({ _id: ACME_TASK }))!.title).toBe("Updated by the document");

  await task!.deleteOne();
  expect(await col("tasks").countDocuments({ _id: ACME_TASK })).toBe(0);
  expect(await col("tasks").countDocuments({ _id: GLOBEX_TASK })).toBe(1);
});

test("overriding a scoped query's organisation with where, merge or setQuery is refused", async () => {
  const db = scoped(ACME);

  await expect(db.Task.find({}).where("organisation", GLOBEX).lean()).rejects.toThrow(WALL);
  await expect(db.Task.find({}).merge({ organisation: GLOBEX }).lean()).rejects.toThrow(WALL);
  const replaced = db.Task.find({}).lean();
  replaced.setQuery({ title: "Globex secret" });
  await expect(replaced).rejects.toThrow(WALL);
  const emptied = db.Task.updateMany({}, { $set: { title: "x" } });
  emptied.setQuery({});
  await expect(emptied).rejects.toThrow(WALL);
  expect(await col("tasks").countDocuments({ title: "x" })).toBe(0);
});

test("a raw model query that names no organisation is refused, for every kind of operation", async () => {
  await expect(Task.find({ title: "Globex secret" }).lean()).rejects.toThrow(WALL);
  await expect(Task.findOne({ _id: GLOBEX_TASK })).rejects.toThrow(WALL);
  await expect(Task.countDocuments({})).rejects.toThrow(WALL);
  await expect(Task.estimatedDocumentCount()).rejects.toThrow(WALL);
  await expect(Task.distinct("title")).rejects.toThrow(WALL);
  await expect(Task.exists({ _id: GLOBEX_TASK })).rejects.toThrow(WALL);
  await expect(Task.updateMany({}, { $set: { title: "x" } })).rejects.toThrow(WALL);
  await expect(Task.deleteMany({})).rejects.toThrow(WALL);
  await expect(Task.findOneAndUpdate({ _id: GLOBEX_TASK }, { $set: { title: "x" } })).rejects.toThrow(WALL);
  await expect(Task.findOneAndDelete({ _id: GLOBEX_TASK })).rejects.toThrow(WALL);
  await expect(Task.aggregate([{ $match: {} }])).rejects.toThrow(WALL);
  await expect(Task.bulkWrite([{ deleteMany: { filter: {} } }])).rejects.toThrow(WALL);
  await expect(Task.find({ organisation: { $in: [ACME, GLOBEX] } }).lean()).rejects.toThrow(/other than one id/);
  expect(await col("tasks").countDocuments({ title: "x" })).toBe(0);
  expect(await col("tasks").countDocuments()).toBe(2);
});

test("the model reached through a scoped query or document is still walled", async () => {
  const query = scoped(ACME).Task.find({});
  await expect((query.model as typeof Task).find({}).lean()).rejects.toThrow(WALL);

  const task = await scoped(ACME).Task.findOne({ _id: ACME_TASK });
  await expect((task!.constructor as typeof Task).deleteMany({})).rejects.toThrow(WALL);
  expect(await col("tasks").countDocuments()).toBe(2);
});

test("an aggregate given a foreign stage after the scoped db built it is refused", async () => {
  const aggregate = scoped(ACME).Task.aggregate([{ $match: {} }]);
  aggregate.append({ $lookup: { from: "users", localField: "assignee", foreignField: "_id", as: "who" } });

  await expect(aggregate).rejects.toThrow(/reaches another collection through \$lookup/);
});

test("a populate on a raw document is refused, because it names no organisation", async () => {
  const project = await scoped(ACME).Project.findOne({ _id: ACME_PROJECT });

  await expect(project!.populate("createdBy", "fullName")).rejects.toThrow(WALL);
});

test("a raw query that names one organisation, or says why it crosses them, runs", async () => {
  expect((await User.find({ username: "boss", organisation: GLOBEX }).lean()).map((user) => user.fullName)).toEqual(["Globex Boss"]);

  const both = await acrossOrganisations(User.find({ username: "boss" }), "e2e: the wall's own escape").lean();
  expect(both).toHaveLength(2);
  expect(await acrossOrganisations(Project.countDocuments({}), "e2e: the wall's own escape")).toBe(1);
});
