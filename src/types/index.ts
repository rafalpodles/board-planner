import { Types } from "mongoose";

export type Difficulty = "S" | "M" | "L" | "XL";

export type Category = string;

export type Priority = "low" | "medium" | "high" | "urgent";

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

export const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const COLUMN_ROLES = ["backlog", "approved", "active", "review", "blocked", "done"] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

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

export type UserRole = "admin" | "member";

export interface IUser {
  _id: Types.ObjectId;
  username: string;
  password: string;
  fullName: string;
  email: string;
  emailNotifications: boolean;
  emailDigest: boolean;
  notifications?: UserNotificationPrefs;
  lastDigestDay: string;
  collapseEmptyColumns: boolean;
  role: UserRole;
  kind: "human" | "machine";
  tokenScoped?: boolean;
  tokenScope?: Types.ObjectId[];
  instanceAdminBeforeScope?: boolean;
  viaMachineCredential?: boolean;
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

export interface ApiWebhook {
  _id: string;
  urlMasked: string;
  events: WebhookEvent[];
  enabled: boolean;
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

export const OPTION_FIELD_TYPES: CustomFieldType[] = ["dropdown", "multiselect"];

export const FIELD_TYPE_LABELS: Record<CustomFieldType, { label: string; hint: string }> = {
  dropdown: { label: "Choice", hint: "Pick one from a list you define" },
  multiselect: { label: "Multi-choice", hint: "Pick any number from a list you define" },
  text: { label: "Text", hint: "Free text" },
  number: { label: "Number", hint: "A numeric value" },
  date: { label: "Date", hint: "A single date" },
  checkbox: { label: "Yes / no", hint: "A tick box" },
};

export const DEFAULT_OPTION_COLOR = "#64748b";

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
  dailyTokenCap?: number;
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

export interface WorkerPolicy {
  pollIntervalMs: number;
}

export interface ProjectWorkerPolicy {
  autoMerge: boolean;
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
  agent?: string | Types.ObjectId | null;
  enabled: boolean;
  policy: ProjectWorkerPolicy;
  policyOverrides: string[];
}

export interface WorkerRepo {
  remote: string;
  path: string;
}

export interface WorkerPreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface WorkerPreflight {
  ok: boolean;
  account: string;
  checks: WorkerPreflightCheck[];
  reportedAt: Date;
}

export interface ApiWorkerPreflight extends Omit<WorkerPreflight, "reportedAt"> {
  reportedAt: string;
}

export interface IDeviceEnrolment {
  _id: Types.ObjectId;
  deviceCodeHash: string;
  deviceCodePrefix: string;
  userCode: string;
  machineName: string;
  machineHost: string;
  status: "pending" | "approved" | "denied";
  enrolledBy: Types.ObjectId | null;
  project: Types.ObjectId | null;
  worker: Types.ObjectId | null;
  credential: string;
  deliveredAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

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
  policyOverrides: string[];
  enabled: boolean;
  lockedByInstance: boolean;
  lastSeenAt: Date | null;
  owner?: Types.ObjectId | IUser | null;
  desiredProjects?: Types.ObjectId[];
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
  assignedByRun?: boolean;
  phase?: string;
  phaseAt?: Date | null;
  phaseSeq?: number;
}

export interface IProject {
  _id: Types.ObjectId;
  name: string;
  key: string;
  formerKeys: string[];
  description: string;
  icon: string;
  categories: IProjectCategory[];
  columns: IProjectColumn[];
  taskTemplates: ITaskTemplate[];
  customFields: ICustomField[];
  estimateFieldId: string;
  webhooks: IWebhook[];
  notificationChannels: INotificationChannel[];
  worker: ProjectWorkerConfig;
  repositoryUrl: string;
  githubRepo: string;
  githubToken: string;
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

export interface IPmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  hitStepLimit: boolean;
}

export interface IPmMessage {
  _id: Types.ObjectId;
  project: Types.ObjectId;
  role: "user" | "assistant";
  content: string;
  usage?: IPmUsage;
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
  endDate?: Date | null;
  anchorDay?: number | null;
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
  assignedBy?: Types.ObjectId | null;
  pmAssignedFor?: Types.ObjectId | null;
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

export interface ApiUserSummary {
  _id: string;
  username: string;
  fullName: string;
}

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
  dailyTokenCap?: number;
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
  anchorDay?: number | null;
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
  assignedBy?: ApiUserSummary | string | null;
  pmAssignedFor?: ApiUserSummary | string | null;
  dueDate: string | null;
  checklist: ApiChecklistItem[];
  linkedPRs: ApiLinkedPR[];
  blockedBy: ApiTaskLink[];
  blocking: ApiTaskLink[];
  relations: ApiTaskRelation[];
  relatedFrom: ApiTaskRelation[];
  watchers: string[];
  sprint: string | null;
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
  "user_email_changed_self",
  "user_password_reset_by_email",
  "user_full_name_changed_self",
  "user_created",
  "user_deleted",
  "user_role_changed",
] as const;

export type InstanceAuditAction = (typeof INSTANCE_AUDIT_ACTIONS)[number];

export interface IInstanceAuditLog {
  _id: Types.ObjectId;
  user: Types.ObjectId | IUser | null;
  actorUsername: string;
  action: InstanceAuditAction;
  target: string;
  detail: string;
  createdAt: Date;
}

export interface ApiInstanceAuditLog {
  _id: string;
  user: { _id: string; username: string; fullName: string } | null;
  actorUsername?: string;
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

export type NotificationType =
  | "task_assigned"
  | "status_changed"
  | "comment_added"
  | "mentioned"
  | "task_created";

export const NOTIFICATION_TYPES: NotificationType[] = [
  "task_assigned",
  "mentioned",
  "status_changed",
  "comment_added",
  "task_created",
];

export const PERSONAL_CHAT_KINDS = ["slack", "discord"] as const;
export type PersonalChatKind = (typeof PERSONAL_CHAT_KINDS)[number];

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
  inApp: boolean;
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

export interface ParsedTask {
  title: string;
  category: Category;
  priority?: Priority;
  status?: TaskStatus;
  assignee?: string;
  description?: string;
  acceptanceCriteria?: string;
}

export const AGENT_BUCKETS = ["analysis", "implementation", "verification", "delivery"] as const;
export type AgentBucket = (typeof AGENT_BUCKETS)[number];

export const AGENT_SCOPES = ["global", "user", "project"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const BLOCK_KINDS = ["step", "gate"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const STEP_CAPABILITIES = ["read-only", "edit"] as const;
export type StepCapability = (typeof STEP_CAPABILITIES)[number];

export interface CompositionEntry {
  key: string;
  params?: Record<string, string>;
}

export type AgentComposition = Record<AgentBucket, CompositionEntry[]>;

export type StoredComposition = Partial<Record<AgentBucket, (CompositionEntry | string)[]>>;

export interface IAgentBlock {
  _id: Types.ObjectId;
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

export interface ApiFleetRun extends ApiAgentRun {
  projectKey: string;
  projectName: string;
  workerName: string;
}
