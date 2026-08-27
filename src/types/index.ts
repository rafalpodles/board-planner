import { Types } from "mongoose";

// Difficulty levels
export type Difficulty = "S" | "M" | "L" | "XL";

// Task categories
// Project-defined since CP-127; the old fixed values remain the per-project defaults
export type Category = string;

// Task priority
export type Priority = "low" | "medium" | "high" | "urgent";

// Task statuses for Kanban columns
export type TaskStatus =
  | "planned"
  | "todo"
  | "in_progress"
  | "in_review"
  | "needs_human_review"
  | "ready_to_test"
  | "done";

export const TASK_STATUSES: TaskStatus[] = [
  "planned",
  "todo",
  "in_progress",
  "in_review",
  "needs_human_review",
  "ready_to_test",
  "done",
];

export const CATEGORIES: Category[] = ["bug", "doc", "user-story", "idea"];

export const DEFAULT_PROJECT_CATEGORIES: { name: string; color: string }[] = [
  { name: "bug", color: "#ef4444" },
  { name: "doc", color: "#3b82f6" },
  { name: "user-story", color: "#22c55e" },
  { name: "idea", color: "#8b5cf6" },
];
export const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];
export const DEFAULT_PRIORITY: Priority = "medium";

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

// Ascending = most urgent first
export const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// Semantic column roles (CP-128) — automation keys on the role, not the display name
export const COLUMN_ROLES = ["backlog", "approved", "active", "review", "blocked", "done"] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

/**
 * What each role means, in the words of someone arranging a board rather than reading
 * the enum. Every automation keys on the role and never on the column's name, so this
 * is the only place the two vocabularies are reconciled for a human.
 */
export const ROLE_LABELS: Record<ColumnRole, { label: string; hint: string }> = {
  backlog: {
    label: "Ideas & backlog",
    hint: "Not approved for work. Nothing picks these up on its own.",
  },
  approved: {
    label: "Ready to pick up",
    hint: "Workers and Claude Code take their next task from here.",
  },
  active: {
    label: "In progress",
    hint: "Where a task is moved once something starts working on it.",
  },
  review: {
    label: "Awaiting review",
    hint: "Finished work waiting on a check.",
  },
  blocked: {
    label: "Blocked",
    hint: "Parked. Left alone by automation.",
  },
  done: {
    label: "Done",
    hint: "Completes the task, and creates the next one if it repeats.",
  },
};

export interface IProjectColumn {
  _id: Types.ObjectId;
  id: string;
  label: string;
  color: string;
  role: ColumnRole;
  order: number;
  triggersPmReview: boolean;
}

export interface ApiProjectColumn {
  _id: string;
  id: string;
  label: string;
  color: string;
  role: ColumnRole;
  order: number;
  triggersPmReview: boolean;
}

// Column ids intentionally equal the legacy TaskStatus values so existing
// task documents and the MCP/Claude-Code automation contract stay valid
export const DEFAULT_PROJECT_COLUMNS: Omit<IProjectColumn, "_id">[] = [
  { id: "planned", label: "Planned", color: "#6b7280", role: "backlog", order: 0, triggersPmReview: false },
  { id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 1, triggersPmReview: false },
  { id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 2, triggersPmReview: false },
  { id: "in_review", label: "In Review", color: "#a855f7", role: "review", order: 3, triggersPmReview: false },
  { id: "needs_human_review", label: "Needs Human Review", color: "#f43f5e", role: "review", order: 4, triggersPmReview: true },
  { id: "ready_to_test", label: "Ready to Test", color: "#06b6d4", role: "review", order: 5, triggersPmReview: false },
  { id: "done", label: "Done", color: "#22c55e", role: "done", order: 6, triggersPmReview: false },
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  planned: "Planned",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  needs_human_review: "Needs Human Review",
  ready_to_test: "Ready to Test",
  done: "Done",
};

// User roles
export type UserRole = "admin" | "member";

// Document interfaces (what Mongoose returns)
export interface IUser {
  _id: Types.ObjectId;
  username: string;
  password: string;
  fullName: string;
  email: string;
  /** @deprecated Superseded by `notifications`. Kept as the fallback for accounts that predate it. */
  emailNotifications: boolean;
  emailDigest: boolean;
  notifications?: UserNotificationPrefs;
  lastDigestDay: string;
  collapseEmptyColumns: boolean;
  role: UserRole;
  // A worker's identity is a user record so authorship, mentions, avatars and history keep
  // working unchanged — but it is not a person, so it stays out of the lists where people are
  // invited, permissioned or picked as an assignee.
  kind: "human" | "machine";
  // Runtime-only, set for project-scoped tokens — a scoped token never gets project-admin
  tokenScoped?: boolean;
  // Runtime-only, set for project-scoped tokens — the projects the token narrowed to
  tokenScope?: Types.ObjectId[];
  // Runtime-only. An instance admin's role is downgraded to member by applyTokenScope, and
  // instance admins hold no grants — without this their scoped tokens would resolve to no access.
  instanceAdminBeforeScope?: boolean;
  // Runtime-only, set for every API and OAuth token. Distinct from tokenScoped, which answers only
  // whether project access was narrowed: an unscoped admin token is still a machine credential, and
  // acts that need a person at a keyboard must key on this instead.
  viaMachineCredential?: boolean;
  // Runtime-only, set for browser sessions — the Session row this request authenticated with, so a
  // handler can spare the calling session when it revokes the rest.
  sessionId?: Types.ObjectId;
  createdAt: Date;
}

export interface ISession {
  _id: Types.ObjectId;
  tokenHash: string;
  user: Types.ObjectId | IUser;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  lastUsedAt: Date;
  userAgent: string;
  ip: string;
  createdAt: Date;
}

export interface IPasswordResetToken {
  _id: Types.ObjectId;
  tokenHash: string;
  user: Types.ObjectId | IUser;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface IApiToken {
  _id: Types.ObjectId;
  user: Types.ObjectId | IUser;
  name: string;
  tokenHash: string;
  prefix: string;
  allowedProjects: Types.ObjectId[];
  lastUsedAt: Date | null;
  createdAt: Date;
}

export const GRANT_RELATIONS = ["owner", "member"] as const;
export type GrantRelation = (typeof GRANT_RELATIONS)[number];

export interface IGrant {
  _id: Types.ObjectId;
  subject: Types.ObjectId;
  relation: GrantRelation;
  objectType: "project";
  object: Types.ObjectId;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiApiToken {
  _id: string;
  name: string;
  prefix: string;
  allowedProjects: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

export interface IOAuthClient {
  _id: Types.ObjectId;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: Date;
}

export interface IOAuthConsent {
  _id: Types.ObjectId;
  ticketHash: string;
  clientId: string;
  user: Types.ObjectId | IUser;
  session: Types.ObjectId | null;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface IOAuthCode {
  _id: Types.ObjectId;
  codeHash: string;
  clientId: string;
  user: Types.ObjectId | IUser;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  allowedProjects: Types.ObjectId[];
  used: boolean;
  expiresAt: Date;
  createdAt: Date;
}

export interface IOAuthToken {
  _id: Types.ObjectId;
  accessTokenHash: string;
  refreshTokenHash: string;
  clientId: string;
  user: Types.ObjectId | IUser;
  scope: string;
  allowedProjects: Types.ObjectId[];
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  createdAt: Date;
}

export interface ILabel {
  _id: Types.ObjectId;
  name: string;
  color: string;
}

export interface IProjectCategory {
  _id: Types.ObjectId;
  name: string;
  color: string;
}

export interface ApiProjectCategory {
  _id: string;
  name: string;
  color: string;
}

export interface ITaskTemplate {
  _id: Types.ObjectId;
  name: string;
  title: string;
  description: string;
  category: Category;
  acceptanceCriteria: string;
}

export type WebhookEvent = "task_created" | "status_changed" | "comment_added";

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  "task_created",
  "status_changed",
  "comment_added",
];

export interface IWebhook {
  _id: Types.ObjectId;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  lastAttemptAt: Date | null;
  lastStatus: "ok" | "failed" | null;
  lastError: string;
}

// The URL never reaches a client: it is a credential, so the API returns only a mask
export interface ApiWebhook {
  _id: string;
  urlMasked: string;
  events: WebhookEvent[];
  enabled: boolean;
  /** Single-shot delivery (BP-407) — this is the outcome of the one attempt, not a retry count. */
  lastAttemptAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastError: string;
}

export type NotificationChannelType = "slack" | "discord";

export const NOTIFICATION_CHANNEL_TYPES: NotificationChannelType[] = ["slack", "discord"];

export interface INotificationChannel {
  _id: Types.ObjectId;
  type: NotificationChannelType;
  name: string;
  webhookUrl: string;
  events: WebhookEvent[];
  enabled: boolean;
}

export interface ApiNotificationChannel {
  _id: string;
  type: NotificationChannelType;
  name: string;
  webhookUrlMasked: string;
  events: WebhookEvent[];
  enabled: boolean;
}

// Custom field types
export type CustomFieldType =
  | "text"
  | "number"
  | "date"
  | "dropdown"
  | "multiselect"
  | "checkbox";

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = [
  "text",
  "number",
  "date",
  "dropdown",
  "multiselect",
  "checkbox",
];

/** The types whose values are option ids rather than a literal */
export const OPTION_FIELD_TYPES: CustomFieldType[] = ["dropdown", "multiselect"];

/** The type picker used to print the union members; these are what a human calls them. */
export const FIELD_TYPE_LABELS: Record<CustomFieldType, { label: string; hint: string }> = {
  dropdown: { label: "Choice", hint: "Pick one from a list you define" },
  multiselect: { label: "Multi-choice", hint: "Pick any number from a list you define" },
  text: { label: "Text", hint: "Free text" },
  number: { label: "Number", hint: "A numeric value" },
  date: { label: "Date", hint: "A single date" },
  checkbox: { label: "Yes / no", hint: "A tick box" },
};

export const DEFAULT_OPTION_COLOR = "#64748b";

// Values store `id`, never `value`, so renaming an option keeps it attached to
// every task that had it
export interface ICustomFieldOption {
  id: string;
  value: string;
  color: string;
  order: number;
}

export interface ICustomField {
  _id: Types.ObjectId;
  name: string;
  fieldType: CustomFieldType;
  options: ICustomFieldOption[];
  required: boolean;
  order: number;
  showOnCard: boolean;
  showInList: boolean;
  filterable: boolean;
  /** Replaces deletion for a field that is already in use: pickers drop it, values survive */
  archived: boolean;
}

export interface ApiCustomField extends Omit<ICustomField, "_id"> {
  _id: string;
}

export interface IPmLink {
  label: string;
  url: string;
}

export const PM_MCP_AUTH_TYPES = ["none", "bearer", "oauth"] as const;
export type PmMcpAuthType = (typeof PM_MCP_AUTH_TYPES)[number];

export const PM_MCP_OAUTH_STATUSES = ["unconfigured", "connected", "needs_reauth"] as const;
export type PmMcpOauthStatus = (typeof PM_MCP_OAUTH_STATUSES)[number];

export interface IPmMcpOauth {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  redirectUri: string;
  scopes: string[];
  tokenAuthMethod: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  status: PmMcpOauthStatus;
}

export interface IPmMcpServer {
  name: string;
  url: string;
  authType: PmMcpAuthType;
  authToken: string;
  oauth?: IPmMcpOauth;
  allowWrites: boolean;
  toolAllowlist: string[];
  enabled: boolean;
}

export interface IPmOauthState {
  _id: Types.ObjectId;
  state: string;
  project: Types.ObjectId;
  serverName: string;
  codeVerifier: string;
  initiatedBy: Types.ObjectId;
  createdAt: Date;
}

export interface IPmAutonomy {
  dailyReview: boolean;
  reviewHour: number;
  reviewIntervalHours: number;
  timezone: string;
  handleNeedsHumanReview: boolean;
  lastReviewSlot: string;
}

export const DEFAULT_PM_AUTONOMY: IPmAutonomy = {
  dailyReview: false,
  reviewHour: 9,
  reviewIntervalHours: 24,
  timezone: "Europe/Warsaw",
  handleNeedsHumanReview: false,
  lastReviewSlot: "",
};

export interface IPmConfig {
  enabled: boolean;
  lockedByInstance?: boolean;
  model: string;
  contextNotes: string;
  links: IPmLink[];
  dailyTurnCap?: number;
  mcpServers?: IPmMcpServer[];
  autonomy?: IPmAutonomy;
}

export const DEFAULT_PROJECT_ICON = "📋";

export const PROJECT_ICONS: string[] = [
  "📋", "🚀", "🐛", "💡", "🎯", "🔧", "📦", "🧪",
  "🎨", "📊", "🔐", "🌐", "📱", "💻", "⚙️", "🗂️",
  "📝", "🔍", "🧩", "⚡", "🔥", "✨", "🏗️", "🛠️",
  "📈", "🗄️", "🤖", "🧠", "🎮", "🛒", "💰", "📚",
  "🏥", "🎬", "🎵", "✈️", "🏠", "🌱", "⏰", "🏆",
];

// Facts about a machine. Everything describing a repository or the work lives on the project.
export interface WorkerPolicy {
  pollIntervalMs: number;
}

export interface ProjectWorkerPolicy {
  autoMerge: boolean;
  // The second model that reads the diff with no memory of writing it. Turning it off is what
  // separates "write code" from "write and review"; autoMerge may not outlive it.
  reviewGate: boolean;
  baseBranch: string;
  taskTimeoutMs: number;
  maxDiffLines: number;
  maxDiffFiles: number;
  model: string;
  fallbackModel: string;
  reviewModel: string;
}

export interface ProjectWorkerConfig {
  // An ObjectId in the document, a string once it has been through JSON. Both readers stringify.
  agent?: string | Types.ObjectId | null;
  enabled: boolean;
  policy: ProjectWorkerPolicy;
  policyOverrides: string[];
}

// What a worker says it has on disk. Reported upward only — the server never sends a path back.
export interface WorkerRepo {
  remote: string;
  path: string;
}

export interface WorkerPreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

// Whether the machine can actually do the work: the four binaries the worker shells out to, the
// session `claude` and `gh` need, and what the gates require of the bound repository. Reported by
// the worker, never set here — null until a worker old enough to compute it has checked in.
export interface WorkerPreflight {
  ok: boolean;
  // Which account `claude` is signed into. Empty when the CLI is too old to answer.
  account: string;
  checks: WorkerPreflightCheck[];
  reportedAt: Date;
}

export interface ApiWorkerPreflight extends Omit<WorkerPreflight, "reportedAt"> {
  reportedAt: string;
}

// An enrolment in progress: the app holds the device code, the person at the machine confirms the
// user code in a browser, and the credential is handed back exactly once.
export interface IDeviceEnrolment {
  _id: Types.ObjectId;
  deviceCodeHash: string;
  deviceCodePrefix: string;
  userCode: string;
  machineName: string;
  machineHost: string;
  status: "pending" | "approved" | "denied";
  // Who confirmed it, which is who the machine then belongs to
  enrolledBy: Types.ObjectId | null;
  project: Types.ObjectId | null;
  worker: Types.ObjectId | null;
  credential: string;
  deliveredAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

// A single-use, short-lived credential whose only power is to register one worker. Deliberately
// not an ApiToken: an ApiToken can be used repeatedly and carries its owner's access.
export interface IEnrolmentToken {
  _id: Types.ObjectId;
  prefix: string;
  tokenHash: string;
  createdBy: Types.ObjectId | IUser;
  label: string;
  expiresAt: Date;
  usedAt: Date | null;
  usedByWorker: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWorker {
  _id: Types.ObjectId;
  name: string;
  host: string;
  platform: string;
  version: string;
  protocolVersion: number;
  credentialHash: string;
  repos: WorkerRepo[];
  policy: WorkerPolicy;
  // Which policy fields an operator actually set; everything else follows the default
  policyOverrides: string[];
  enabled: boolean;
  lockedByInstance: boolean;
  lastSeenAt: Date | null;
  // The person this machine belongs to, and the only thing that decides what it may reach: null
  // for a worker enrolled before BP-358, which claims nothing until it is enrolled again
  owner?: Types.ObjectId | IUser | null;
  // Which projects the operator picked for this machine, from the browser screen that lists them.
  // Stored because it cannot be derived: what a machine HAS is its reported checkouts, and what
  // somebody WANTS it to have is a different question — the gap between the two is exactly the
  // work the app then does (clone the missing, remove the unwanted). Empty means nobody has ever
  // used that screen, which is not the same as "wants nothing" and must not be read as a request
  // to remove everything.
  desiredProjects?: Types.ObjectId[];
  // The user this machine acts as — see src/lib/worker-user.ts
  identity: Types.ObjectId | null;
  bindingError: string;
  preflight: WorkerPreflight | null;
  command: "" | "pause" | "resume" | "stop";
  commandIssuedAt: Date | null;
  commandAckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiWorker {
  _id: string;
  name: string;
  host: string;
  platform: string;
  version: string;
  protocolVersion: number;
  repos: WorkerRepo[];
  // Whose machine this is. Null is not cosmetic: such a worker reaches no project at all.
  owner: ApiUserSummary | null;
  policy: WorkerPolicy;
  policyOverrides: string[];
  enabled: boolean;
  lockedByInstance: boolean;
  lastSeenAt: string | null;
  bindingError: string;
  preflight: ApiWorkerPreflight | null;
  command: "" | "pause" | "resume" | "stop";
  commandIssuedAt: string | null;
  commandAckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stale: boolean;
  // The task this worker holds right now, if any. Phase lives on the task, not the worker, so the
  // route has to join — a worker document alone cannot answer "what is it doing".
  currentTask?: ApiWorkerTask;
}

export interface ApiWorkerTask {
  taskId: string;
  taskKey: string;
  title: string;
  phase?: string;
  phaseAt?: string | null;
}

export interface ITaskExecution {
  runId: string;
  workerId: string;
  attempts: number;
  startedAt: Date | null;
  lastError: string;
  // Whether the claim is what assigned the task, which decides whether releasing it may clear the
  // assignee again. Absent on anything claimed before the field existed, where it means true.
  assignedByRun?: boolean;
  // Absent until the run that holds the task reports one, and unset again the moment it leaves
  // the active column — so "no phase" is a missing field, never a stale one
  phase?: string;
  phaseAt?: Date | null;
  phaseSeq?: number;
}

export interface IProject {
  _id: Types.ObjectId;
  name: string;
  key: string;
  /** Keys this project used to have, so a rename does not orphan its pull requests */
  formerKeys: string[];
  description: string;
  icon: string;
  categories: IProjectCategory[];
  columns: IProjectColumn[];
  taskTemplates: ITaskTemplate[];
  customFields: ICustomField[];
  // Which custom field's numeric value sums as this project's estimate. "" means the
  // project does not estimate. Must always name a live number field — cleared by the
  // custom-fields route the moment that field is archived or deleted.
  estimateFieldId: string;
  webhooks: IWebhook[];
  notificationChannels: INotificationChannel[];
  worker: ProjectWorkerConfig;
  repositoryUrl: string;
  /** @deprecated superseded by repositoryUrl; read only as a migration fallback */
  githubRepo: string;
  githubToken: string;
  /** @deprecated superseded by repositoryUrl; read only as a migration fallback */
  gitlabRepo: string;
  gitlabHost: string;
  gitlabToken: string;
  codaHost: string;
  codaDocId: string;
  codaTableId: string;
  codaToken: string;
  taskCounter: number;
  sortOrder: number;
  pm?: IPmConfig;
  createdBy: Types.ObjectId | IUser | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IPmAction {
  tool: string;
  taskKey?: string;
  summary: string;
  at: Date;
}

export const PM_TRIGGER_TYPES = ["chat", "daily_review", "needs_human_review"] as const;
export type PmTriggerType = (typeof PM_TRIGGER_TYPES)[number];

export interface PmMessageTrigger {
  type: PmTriggerType;
  taskKey?: string;
}

export interface IPmMessage {
  _id: Types.ObjectId;
  project: Types.ObjectId;
  role: "user" | "assistant";
  content: string;
  actions: IPmAction[];
  attachments: PmAttachment[];
  trigger: PmMessageTrigger;
  triggeredBy: Types.ObjectId | IUser | null;
  createdAt: Date;
}

export const PM_TRIGGER_STATES = ["pending", "running", "done", "failed"] as const;
export type PmTriggerState = (typeof PM_TRIGGER_STATES)[number];

export interface IPmTrigger {
  _id: Types.ObjectId;
  project: Types.ObjectId;
  type: "needs_human_review";
  taskKey: string;
  task: Types.ObjectId;
  state: PmTriggerState;
  active: boolean;
  attempts: number;
  lastError: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ILinkedPR {
  _id: Types.ObjectId;
  provider?: "github" | "gitlab";
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  mergedAt: Date | null;
  updatedAt: Date;
}

export interface ApiLinkedPR {
  _id: string;
  provider?: "github" | "gitlab";
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  mergedAt: string | null;
  updatedAt: string;
}

export interface IChecklistItem {
  _id: Types.ObjectId;
  text: string;
  done: boolean;
}

export interface ApiChecklistItem {
  _id: string;
  text: string;
  done: boolean;
}

// Sprint statuses
export type SprintStatus = "planned" | "active" | "completed";

export const SPRINT_STATUSES: SprintStatus[] = ["planned", "active", "completed"];

export const SPRINT_STATUS_LABELS: Record<SprintStatus, string> = {
  planned: "Planned",
  active: "Active",
  completed: "Completed",
};

export interface ISprint {
  _id: Types.ObjectId;
  project: Types.ObjectId | IProject;
  name: string;
  startDate: Date;
  endDate: Date;
  goal: string;
  status: SprintStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiSprint {
  _id: string;
  project: string;
  name: string;
  startDate: string;
  endDate: string;
  goal: string;
  status: SprintStatus;
  taskCount?: number;
  doneCount?: number;
  // Present only when the project designates an estimate field
  estimateTotal?: number;
  estimateDone?: number;
  createdAt: string;
  updatedAt: string;
}

export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export const RECURRENCE_FREQUENCIES: RecurrenceFrequency[] = ["daily", "weekly", "monthly"];

export interface IRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  /** The day the series stops after. Null — and absent, on a task stored before BP-463 — is a series with no end. */
  endDate?: Date | null;
}

export interface ITask {
  _id: Types.ObjectId;
  project: Types.ObjectId | IProject;
  taskNumber: number;
  title: string;
  description: string;
  priority: Priority;
  category: Category;
  status: TaskStatus;
  assignee: Types.ObjectId | IUser | null;
  // Who set assignee; absent on a task assigned before BP-358
  assignedBy?: Types.ObjectId | null;
  dueDate: Date | null;
  checklist: IChecklistItem[];
  linkedPRs: ILinkedPR[];
  blockedBy: (Types.ObjectId | ITask)[];
  relations: ITaskRelation[];
  watchers: Types.ObjectId[];
  sprint: Types.ObjectId | ISprint | null;
  agent: Types.ObjectId | IAgent | null;
  customFieldValues: Map<string, unknown>;
  recurrence: IRecurrence | null;
  recurringParentId: Types.ObjectId | null;
  order: number;
  execution: ITaskExecution;
  createdBy: Types.ObjectId | IUser;
  createdAt: Date;
  updatedAt: Date;
}

export interface IReaction {
  emoji: string;
  user: Types.ObjectId | IUser;
}

export interface IComment {
  _id: Types.ObjectId;
  task: Types.ObjectId | ITask;
  author: Types.ObjectId | IUser;
  body: string;
  reactions: IReaction[];
  createdAt: Date;
  updatedAt: Date;
}

// API response types (serialized, no ObjectId)
export interface ApiUser {
  _id: string;
  username: string;
  fullName: string;
  email: string;
  emailNotifications: boolean;
  emailDigest?: boolean;
  collapseEmptyColumns?: boolean;
  role: UserRole;
  createdAt: string;
}

/** What GET /api/projects/:id/assignable-users returns: enough to name someone and assign them */
export interface ApiUserSummary {
  _id: string;
  username: string;
  fullName: string;
}

// Enough to NAME the agent a task carries. `/api/agents` answers only with agents the reader may
// choose, so a personal agent belonging to somebody else is absent from that list — and a picker
// that cannot resolve the id renders its empty state, which says "No agent" over a task that has
// one. The name has to travel with the task itself.
export interface ApiAgentSummary {
  _id: string;
  name: string;
}

export interface ApiLabel {
  _id: string;
  name: string;
  color: string;
}

export interface ApiTaskTemplate {
  _id: string;
  name: string;
  title: string;
  description: string;
  category: Category;
  acceptanceCriteria: string;
}

export interface ApiProject {
  worker: ProjectWorkerConfig;
  _id: string;
  name: string;
  key: string;
  // Every key this board has answered to. Renaming a project renames all its task keys at once
  // while the text people already wrote keeps the old prefix, so recognising a written reference
  // needs both — see remarkTaskReferences.
  formerKeys?: string[];
  description: string;
  icon: string;
  categories?: ApiProjectCategory[];
  columns?: ApiProjectColumn[];
  taskTemplates: ApiTaskTemplate[];
  customFields: ApiCustomField[];
  estimateFieldId: string;
  webhooks: ApiWebhook[];
  notificationChannels: ApiNotificationChannel[];
  repositoryUrl: string;
  // Which of the two integrations that URL's host resolves to, "" when neither
  repositoryProvider: "github" | "gitlab" | "";
  githubTokenSet: boolean;
  gitlabHost?: string;
  gitlabTokenSet?: boolean;
  codaHost?: string;
  codaDocId?: string;
  codaTableId?: string;
  codaTokenSet?: boolean;
  taskCounter: number;
  sortOrder?: number;
  // Sidebar badges, computed by the list endpoint only
  taskCount?: number;
  hasActiveSprint?: boolean;
  pm?: ApiPmConfig;
  pmAvailable?: boolean;
  createdBy?: ApiUser | string;
  canAdmin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiProjectMember {
  _id: string;
  username: string;
  fullName: string;
  relation: GrantRelation | null;
  instanceAdmin: boolean;
}

export interface ApiMemberCandidate {
  _id: string;
  username: string;
  fullName: string;
}

export interface ApiPmMcpServer {
  name: string;
  url: string;
  authType: PmMcpAuthType;
  allowWrites: boolean;
  toolAllowlist: string[];
  enabled: boolean;
  hasAuthToken: boolean;
  oauthStatus?: PmMcpOauthStatus;
  oauthClientId?: string;
}

export interface ApiPmConfig {
  enabled: boolean;
  lockedByInstance?: boolean;
  model: string;
  contextNotes: string;
  links: IPmLink[];
  dailyTurnCap?: number;
  mcpServers?: ApiPmMcpServer[];
  autonomy?: IPmAutonomy;
}

export interface ApiPmAction {
  tool: string;
  taskKey?: string;
  summary: string;
  at: string;
}

export interface PmAttachment {
  fileId: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface ApiPmMessage {
  _id: string;
  project: string;
  role: "user" | "assistant";
  content: string;
  actions: ApiPmAction[];
  attachments?: PmAttachment[];
  trigger: PmMessageTrigger;
  triggeredBy: ApiUser | string | null;
  createdAt: string;
}

export const RELATION_TYPES = ["relates", "duplicates", "parent_of"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

// Every dependency kind the UI can add, including the one stored as blockedBy
export const DEPENDENCY_TYPES = ["blocked_by", ...RELATION_TYPES] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export interface ITaskRelation {
  task: Types.ObjectId | ITask;
  type: RelationType;
}

export interface ApiTaskRelation {
  task: ApiTaskLink;
  type: RelationType;
}

export interface ApiTaskLink {
  _id: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
}

export interface ApiRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  endDate?: string | null;
}

export interface ApiTask {
  _id: string;
  project: string;
  taskKey: string;
  taskNumber: number;
  title: string;
  description: string;
  priority: Priority;
  category: Category;
  status: TaskStatus;
  assignee: ApiUser | null;
  // Who set the assignee, and the only thing that says whether a machine may act on it: a task is
  // run unattended when its assignee handed it to themselves. Absent on anything assigned before
  // BP-358, where the answer is not recorded anywhere and is deliberately not guessed.
  assignedBy?: ApiUserSummary | string | null;
  dueDate: string | null;
  checklist: ApiChecklistItem[];
  linkedPRs: ApiLinkedPR[];
  blockedBy: ApiTaskLink[];
  blocking: ApiTaskLink[];
  relations: ApiTaskRelation[];
  relatedFrom: ApiTaskRelation[];
  watchers: string[];
  sprint: string | null;
  // Populated where the task is read whole, a bare id where a writer echoes back what it sent —
  // the same union `assignedBy` above carries, and for the same reason
  agent?: ApiAgentSummary | string | null;
  customFieldValues: Record<string, unknown>;
  recurrence: ApiRecurrence | null;
  recurringParentId: string | null;
  order: number;
  createdBy: ApiUser | string;
  createdAt: string;
  updatedAt: string;
  execution?: ApiTaskExecution;
}

// Only what a reader needs. lastError is deliberately absent — task-service writes it as "" and
// never anything else — and so is attempts, which is decremented on refund and therefore counts
// remaining budget, not the attempt number.
// Returned with a 409 when a status change would take a task off the worker running it, so the
// caller can name who holds it and offer to take it anyway
export interface RunConflict {
  workerId: string;
  workerName?: string;
  phase: string;
  phaseAt: string | null;
}

export interface ApiTaskExecution {
  workerId?: string;
  workerName?: string;
  phase?: string;
  phaseAt?: string | null;
  startedAt?: string | null;
  // the server's clock when this was serialised, so ages can be measured against it rather than
  // against the reader's, which may be minutes off in either direction
  asOf?: string;
}

export interface ApiReaction {
  emoji: string;
  user: ApiUser | string;
}

export interface ApiComment {
  _id: string;
  task: string;
  author: ApiUser | string;
  body: string;
  reactions: ApiReaction[];
  createdAt: string;
  updatedAt: string;
}

// Sort options for board columns
export type SortField =
  | "manual"
  | "key"
  | "updatedAt"
  | "createdAt"
  | "dueDate"
  | "priority"
  | "category"
  | "title"
  | "status"
  | "assignee"
  | "sprint";
export type SortDir = "asc" | "desc";

/** A sort key is a built-in field or a project field's id (CP-212). The `string & {}`
 * keeps editor completion for the built-ins instead of collapsing to plain string. */
export type SortKey = SortField | (string & {});

export const SORT_OPTIONS: { value: SortField; label: string; defaultDir: SortDir }[] = [
  { value: "manual", label: "Manual order", defaultDir: "asc" },
  { value: "key", label: "Key", defaultDir: "asc" },
  { value: "updatedAt", label: "Last updated", defaultDir: "desc" },
  { value: "createdAt", label: "Created", defaultDir: "desc" },
  { value: "dueDate", label: "Due date", defaultDir: "asc" },
  { value: "priority", label: "Priority", defaultDir: "asc" },
  { value: "category", label: "Category", defaultDir: "asc" },
  { value: "title", label: "Title", defaultDir: "asc" },
  { value: "status", label: "Status", defaultDir: "asc" },
  { value: "assignee", label: "Assignee", defaultDir: "asc" },
  { value: "sprint", label: "Sprint", defaultDir: "asc" },
];

// The board already groups by status and shows no assignee, sprint or component
// column, so those four read as nonsense in its dropdown. The list offers all.
export const BOARD_SORT_FIELDS: SortField[] = [
  "manual",
  "key",
  "updatedAt",
  "createdAt",
  "dueDate",
  "priority",
  "category",
  "title",
];

export const LIST_SORT_FIELDS: SortField[] = SORT_OPTIONS.map((o) => o.value);

export function defaultSortDir(field: SortKey): SortDir {
  return SORT_OPTIONS.find((o) => o.value === field)?.defaultDir ?? "asc";
}

// Activity log
export type ActivityAction =
  | "created"
  | "updated"
  | "status_changed"
  | "comment_added"
  | "comment_edited"
  | "comment_deleted";

export interface IActivityLog {
  _id: Types.ObjectId;
  task: Types.ObjectId;
  user: Types.ObjectId | IUser;
  action: ActivityAction;
  field: string;
  oldValue: string;
  newValue: string;
  createdAt: Date;
}

export interface ApiActivityLog {
  _id: string;
  task: string;
  user: { _id: string; username: string; fullName: string } | string;
  action: ActivityAction;
  field: string;
  oldValue: string;
  newValue: string;
  createdAt: string;
}

// Project audit log
export type ProjectAuditAction =
  | "settings_updated"
  | "component_added"
  | "component_removed"
  | "label_added"
  | "label_removed"
  | "template_added"
  | "template_removed"
  | "template_updated"
  | "member_added"
  | "member_removed"
  | "task_created"
  | "task_deleted"
  | "bulk_delete"
  | "bulk_move"
  | "worker_updated";

// The kill switch first, because "who stopped this machine" is the question this log exists to
// answer. Separate verbs rather than one worker_updated with a detail column: an operator scanning
// the list should not have to read the next column to find out what happened.
export const INSTANCE_AUDIT_ACTIONS = [
  "worker_locked",
  "worker_unlocked",
  "worker_enabled",
  "worker_disabled",
  "worker_renamed",
  "worker_released",
  "worker_poll_interval_changed",
  "enrolment_token_minted",
  "enrolment_token_spent",
  "project_workers_enabled",
  "project_workers_disabled",
  "project_worker_policy_changed",
  "worker_command_sent",
  "user_password_reset",
  "user_email_changed",
  // Distinct from the admin action above, because the audit page has to name the right actor: an
  // account moving its own recovery address is the borrowed-session case, and a row reading
  // "changed by an admin" would send an investigator looking at the wrong person (BP-354)
  "user_email_changed_self",
  "user_password_reset_by_email",
  // A display name is not authority — it is never matched on, and the username it sits beside is.
  // It is what a comment is signed with, though, so this row is the only place the change is
  // recorded at all (BP-410)
  "user_full_name_changed_self",
] as const;

export type InstanceAuditAction = (typeof INSTANCE_AUDIT_ACTIONS)[number];

export interface IInstanceAuditLog {
  _id: Types.ObjectId;
  // Absent when a machine did it: a worker spends its enrolment token with no session behind it
  user: Types.ObjectId | IUser | null;
  action: InstanceAuditAction;
  target: string;
  detail: string;
  createdAt: Date;
}

export interface ApiInstanceAuditLog {
  _id: string;
  user: { _id: string; username: string; fullName: string } | null;
  action: InstanceAuditAction;
  target: string;
  detail: string;
  createdAt: string;
}

export interface IProjectAuditLog {
  _id: Types.ObjectId;
  project: Types.ObjectId;
  user: Types.ObjectId | IUser;
  action: ProjectAuditAction;
  detail: string;
  createdAt: Date;
}

export interface ApiProjectAuditLog {
  _id: string;
  project: string;
  user: { _id: string; username: string; fullName: string } | string;
  action: ProjectAuditAction;
  detail: string;
  createdAt: string;
}

// In-app notification types
export type NotificationType =
  | "task_assigned"
  | "status_changed"
  | "comment_added"
  | "mentioned"
  | "task_created";

// The order the settings grid renders them in. task_created is last because it is the only row
// whose recipients are not derived from a task: the other four filter a list the system already
// computed from an assignee and watchers, this one selects people by the tick itself.
export const NOTIFICATION_TYPES: NotificationType[] = [
  "task_assigned",
  "mentioned",
  "status_changed",
  "comment_added",
  "task_created",
];

export const PERSONAL_CHAT_KINDS = ["slack", "discord"] as const;
export type PersonalChatKind = (typeof PERSONAL_CHAT_KINDS)[number];

/** One row of the grid: where a single event is allowed to go. */
export interface NotificationChannels {
  inApp: boolean;
  email: boolean;
  chat: boolean;
}

export type NotificationMatrix = Record<NotificationType, NotificationChannels>;

export interface ProjectNotificationOverride {
  project: Types.ObjectId;
  matrix: NotificationMatrix;
}

export interface UserNotificationPrefs {
  defaults?: NotificationMatrix;
  /** A row here IS the override switch for that project — there is no separate flag to disagree with. */
  projects: ProjectNotificationOverride[];
  chat: { kind: PersonalChatKind | ""; webhookUrl: string };
}

export interface INotification {
  _id: Types.ObjectId;
  recipient: Types.ObjectId;
  type: NotificationType;
  task: Types.ObjectId | ITask;
  project: Types.ObjectId | IProject;
  actor: Types.ObjectId | IUser;
  title: string;
  body: string;
  read: boolean;
  /** Whether the bell shows this row. The document is stored either way, because the digest is
   *  assembled from these and hiding one must not empty tomorrow's mail. */
  inApp: boolean;
  /** Set only on hidden rows, which nothing can mark read — it is what expires them. */
  hiddenAt?: Date;
  createdAt: Date;
}

export interface ApiNotification {
  _id: string;
  recipient: string;
  type: NotificationType;
  task: { _id: string; taskNumber: number; title: string } | string;
  project: { _id: string; key: string; name: string } | string;
  actor: { _id: string; username: string; fullName: string } | string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

// Parsed markdown task for import
export interface ParsedTask {
  title: string;
  category: Category;
  priority?: Priority;
  status?: TaskStatus;
  assignee?: string;
  description?: string;
  acceptanceCriteria?: string;
}

// ---------------------------------------------------------------------------
// Agents: what a worker does between claiming a task and delivering it. Until
// BP-331 this was a hardcoded array in worker/src.

export const AGENT_BUCKETS = ["analysis", "implementation", "verification", "delivery"] as const;
export type AgentBucket = (typeof AGENT_BUCKETS)[number];

export const AGENT_SCOPES = ["global", "user", "project"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const BLOCK_KINDS = ["step", "gate"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

// What a step may touch. The worker owns these; the server names one and never composes a tool list.
export const STEP_CAPABILITIES = ["read-only", "edit"] as const;
export type StepCapability = (typeof STEP_CAPABILITIES)[number];

/**
 * One position in a sequence. A block says what it does; an entry says how it does it *here* —
 * which is why this is an object and not the key alone. Two Size gates with different limits, or a
 * step told something extra for this agent only, need somewhere to put it that is not the catalog.
 */
export interface CompositionEntry {
  key: string;
  /** Overrides the block's own parameters, for this position only. */
  params?: Record<string, string>;
}

export type AgentComposition = Record<AgentBucket, CompositionEntry[]>;

/** What a stored composition may look like: entries, or the bare keys written before entries. */
export type StoredComposition = Partial<Record<AgentBucket, (CompositionEntry | string)[]>>;

export interface IAgentBlock {
  _id: Types.ObjectId;
  key: string;
  kind: BlockKind;
  name: string;
  description: string;
  builtIn: boolean;
  /** gate only — the worker implementation this configures */
  gateKind: string;
  params: Record<string, string>;
  /** step only */
  prompt: string;
  capability: StepCapability;
  model: string;
  fallbackModel: string;
  /** a worker action rather than a model call */
  deterministic: boolean;
  createdBy: Types.ObjectId | IUser | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgent {
  _id: Types.ObjectId;
  name: string;
  description: string;
  scope: AgentScope;
  owner: Types.ObjectId | IUser | null;
  project: Types.ObjectId | IProject | null;
  composition: AgentComposition;
  builtIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiAgentBlock {
  _id: string;
  key: string;
  kind: BlockKind;
  name: string;
  description: string;
  builtIn: boolean;
  gateKind: string;
  params: Record<string, string>;
  prompt: string;
  capability: StepCapability;
  model: string;
  fallbackModel: string;
  deterministic: boolean;
}

export interface ApiAgent {
  _id: string;
  name: string;
  description: string;
  scope: AgentScope;
  projectId: string | null;
  projectName: string | null;
  composition: AgentComposition;
  builtIn: boolean;
}

// A run that finished, kept after the task's own execution fields are cleared.
export const AGENT_RUN_OUTCOMES = [
  "delivered",
  "merged",
  "refused",
  "blocked",
  "failed",
  "requeued",
  "released",
] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];

export interface IAgentRun {
  _id: Types.ObjectId;
  project: Types.ObjectId | IProject;
  task: Types.ObjectId | ITask;
  taskKey: string;
  worker: Types.ObjectId | null;
  agent: Types.ObjectId | IAgent | null;
  agentName: string;
  outcome: AgentRunOutcome;
  refusedBy: string;
  detail: string;
  startedAt: Date;
  finishedAt: Date;
  costUsd: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiAgentRun {
  _id: string;
  taskKey: string;
  agentName: string;
  outcome: AgentRunOutcome;
  refusedBy: string;
  detail: string;
  minutes: number;
  costUsd: number;
  finishedAt: string;
}

/** A run read from the fleet console, where the project and the machine are not implied. */
export interface ApiFleetRun extends ApiAgentRun {
  projectKey: string;
  projectName: string;
  workerName: string;
}
