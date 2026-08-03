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
  emailNotifications: boolean;
  collapseEmptyColumns: boolean;
  role: UserRole;
  allowedProjects: Types.ObjectId[];
  // Runtime-only, set for project-scoped tokens — a scoped token never gets project-admin
  tokenScoped?: boolean;
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
}

export interface ApiWebhook {
  _id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
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
  webhookUrl: string;
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

export interface IProject {
  _id: Types.ObjectId;
  name: string;
  key: string;
  description: string;
  icon: string;
  categories: IProjectCategory[];
  columns: IProjectColumn[];
  taskTemplates: ITaskTemplate[];
  customFields: ICustomField[];
  webhooks: IWebhook[];
  notificationChannels: INotificationChannel[];
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
  owner: Types.ObjectId | IUser;
  admins: (Types.ObjectId | IUser)[];
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
  createdAt: string;
  updatedAt: string;
}

export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export interface IRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
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
  dueDate: Date | null;
  checklist: IChecklistItem[];
  linkedPRs: ILinkedPR[];
  pinned: boolean;
  blockedBy: (Types.ObjectId | ITask)[];
  relations: ITaskRelation[];
  watchers: Types.ObjectId[];
  sprint: Types.ObjectId | ISprint | null;
  customFieldValues: Map<string, unknown>;
  recurrence: IRecurrence | null;
  recurringParentId: Types.ObjectId | null;
  order: number;
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
  collapseEmptyColumns?: boolean;
  role: UserRole;
  allowedProjects: string[];
  createdAt: string;
}

/** What GET /api/users/list returns: enough to name someone and assign them */
export interface ApiUserSummary {
  _id: string;
  username: string;
  fullName: string;
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
  _id: string;
  name: string;
  key: string;
  description: string;
  icon: string;
  categories?: ApiProjectCategory[];
  columns?: ApiProjectColumn[];
  taskTemplates: ApiTaskTemplate[];
  customFields: ApiCustomField[];
  webhooks: ApiWebhook[];
  notificationChannels: ApiNotificationChannel[];
  githubRepo: string;
  githubTokenSet: boolean;
  gitlabRepo?: string;
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
  owner: ApiUser | string;
  admins?: ApiProjectMember[];
  canAdmin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiProjectMember {
  _id: string;
  username: string;
  fullName: string;
  role?: UserRole;
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
  dueDate: string | null;
  checklist: ApiChecklistItem[];
  linkedPRs: ApiLinkedPR[];
  pinned: boolean;
  blockedBy: ApiTaskLink[];
  blocking: ApiTaskLink[];
  relations: ApiTaskRelation[];
  relatedFrom: ApiTaskRelation[];
  watchers: string[];
  sprint: string | null;
  customFieldValues: Record<string, unknown>;
  recurrence: ApiRecurrence | null;
  recurringParentId: string | null;
  order: number;
  createdBy: ApiUser | string;
  createdAt: string;
  updatedAt: string;
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
  | "difficulty"
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
  | "bulk_move";

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
export type NotificationType = "task_assigned" | "status_changed" | "comment_added" | "mentioned";

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
