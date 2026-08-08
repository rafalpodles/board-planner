import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Never the development database. The URI is passed to the dev server too, so a mistake here
// would have the browser writing into whatever the developer is using at the time.
export const E2E_MONGODB_URI =
  process.env.E2E_MONGODB_URI ?? "mongodb://localhost:27017/claudeplanner_e2e";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "test1234";

export const PROJECT_KEY = "TP";
// Deliberately not "Test Project": a project keyed TP also exists in the development database,
// so the name is what proves which one the server is actually reading.
export const PROJECT_NAME = "E2E Run Conflict Board";

export const WORKER_NAME = "e2e-macbook-pro";
export const RUN_PHASE = "agent";

export const HELD_TASK_NUMBER = 1;
export const HELD_TASK_KEY = `${PROJECT_KEY}-${HELD_TASK_NUMBER}`;
export const HELD_TASK_TITLE = "Held by a live worker run";

export const DECOY_TASK_NUMBER = 2;
export const DECOY_TASK_TITLE = "Already in review";

export const SOURCE_COLUMN = { id: "in_progress", label: "In Progress" };
export const TARGET_COLUMN = { id: "in_review", label: "In Review" };

const id = (hex: string) => new mongoose.Types.ObjectId(hex);

export const ADMIN_ID = id("e2e00000000000000000a001");
export const PROJECT_ID = id("e2e00000000000000000c001");
export const WORKER_ID = id("e2e00000000000000000b001");
export const HELD_TASK_ID = id("e2e00000000000000000d001");
export const DECOY_TASK_ID = id("e2e00000000000000000d002");

const COLUMNS = [
  { id: "planned", label: "Planned", color: "#6b7280", role: "backlog", order: 0 },
  { id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 1 },
  { id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 2 },
  { id: "in_review", label: "In Review", color: "#a855f7", role: "review", order: 3 },
  { id: "needs_human_review", label: "Needs Human Review", color: "#f43f5e", role: "review", order: 4 },
  { id: "ready_to_test", label: "Ready to Test", color: "#06b6d4", role: "review", order: 5 },
  { id: "done", label: "Done", color: "#22c55e", role: "done", order: 6 },
].map((c) => ({ _id: new mongoose.Types.ObjectId(), triggersPmReview: c.id === "needs_human_review", ...c }));

const CATEGORIES = [
  { name: "bug", color: "#ef4444" },
  { name: "doc", color: "#3b82f6" },
  { name: "user-story", color: "#22c55e" },
  { name: "idea", color: "#8b5cf6" },
].map((c) => ({ _id: new mongoose.Types.ObjectId(), ...c }));

async function connect() {
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) {
    throw new Error(
      `Refusing to touch database "${dbName}": the e2e fixture only runs against a *_e2e database`
    );
  }
  await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection;
}

// The whole database, not a list of collections: this one exists for the fixture, and a run
// leaves activity logs and notifications behind that a fixed list would keep missing.
async function empty(db: mongoose.mongo.Db) {
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  await Promise.all(names.map((name) => db.collection(name).deleteMany({})));
}

export async function wipe() {
  await empty((await connect()).db!);
  await mongoose.disconnect();
}

export async function seed() {
  const db = (await connect()).db!;
  await empty(db);

  const now = new Date();

  await db.collection("users").insertOne({
    _id: ADMIN_ID,
    username: ADMIN_USERNAME,
    password: bcrypt.hashSync(ADMIN_PASSWORD, 10),
    fullName: "E2E Admin",
    email: "",
    emailNotifications: false,
    // Off, so every column stays a real drop target instead of collapsing to a rail
    collapseEmptyColumns: false,
    role: "admin",
    kind: "human",
    createdAt: now,
  });

  await db.collection("projects").insertOne({
    _id: PROJECT_ID,
    name: PROJECT_NAME,
    key: PROJECT_KEY,
    description: "Seeded by the Playwright run-conflict test",
    icon: "",
    categories: CATEGORIES,
    columns: COLUMNS,
    taskTemplates: [],
    customFields: [],
    webhooks: [],
    notificationChannels: [],
    pm: {
      enabled: false,
      lockedByInstance: false,
      model: "",
      contextNotes: "",
      dailyTurnCap: 0,
      autonomy: {
        dailyReview: false,
        reviewHour: 9,
        reviewIntervalHours: 24,
        timezone: "Europe/Warsaw",
        handleNeedsHumanReview: false,
        lastReviewSlot: "",
      },
      links: [],
      mcpServers: [],
    },
    worker: {
      enabled: true,
      policy: {
        autoMerge: false,
        reviewGate: true,
        baseBranch: "main",
        taskTimeoutMs: 1_800_000,
        maxDiffLines: 400,
        maxDiffFiles: 10,
        model: "opus",
        fallbackModel: "sonnet",
        reviewModel: "opus",
      },
      policyOverrides: [],
    },
    repositoryUrl: "",
    githubRepo: "",
    githubToken: "",
    gitlabRepo: "",
    gitlabHost: "https://gitlab.com",
    gitlabToken: "",
    codaHost: "https://coda.io",
    codaDocId: "",
    codaTableId: "",
    codaToken: "",
    taskCounter: 2,
    sortOrder: 0,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  await db.collection("workers").insertOne({
    _id: WORKER_ID,
    name: WORKER_NAME,
    host: "e2e-host",
    platform: "darwin",
    version: "0.0.0-e2e",
    protocolVersion: 1,
    credentialHash: bcrypt.hashSync("e2e-worker-credential", 10),
    repos: [],
    policy: { pollIntervalMs: 30_000 },
    policyOverrides: [],
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: now,
    identity: null,
    bindingError: "",
    preflight: null,
    command: "",
    commandIssuedAt: null,
    commandAckedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const task = (over: Record<string, unknown>) => ({
    project: PROJECT_ID,
    description: "",
    priority: "medium",
    category: "user-story",
    assignee: null,
    dueDate: null,
    checklist: [],
    linkedPRs: [],
    blockedBy: [],
    relations: [],
    watchers: [],
    sprint: null,
    customFieldValues: {},
    recurrence: null,
    recurringParentId: null,
    order: 0,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
    ...over,
  });

  await db.collection("tasks").insertMany([
    task({
      _id: HELD_TASK_ID,
      taskNumber: HELD_TASK_NUMBER,
      title: HELD_TASK_TITLE,
      status: SOURCE_COLUMN.id,
      // runId is what makes the run live: task-service keys the refusal on it, and clears it
      // on release. phaseAt is stamped now so the card reads as alive rather than gone quiet.
      execution: {
        runId: "e2e-run-0001",
        workerId: String(WORKER_ID),
        attempts: 1,
        startedAt: new Date(now.getTime() - 60_000),
        lastError: "",
        phase: RUN_PHASE,
        phaseAt: now,
        phaseSeq: 7,
      },
    }),
    task({
      _id: DECOY_TASK_ID,
      taskNumber: DECOY_TASK_NUMBER,
      title: DECOY_TASK_TITLE,
      status: TARGET_COLUMN.id,
      order: 1,
    }),
  ]);

  await mongoose.disconnect();
}
