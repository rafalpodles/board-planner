import { Types } from "mongoose";

// Difficulty levels
export type Difficulty = "S" | "M" | "L" | "XL";

// Task categories
export type Category = "bug" | "doc" | "user-story" | "idea";

// Task statuses for Kanban columns
export type TaskStatus =
  | "planned"
  | "todo"
  | "in_progress"
  | "in_review"
  | "ready_to_test"
  | "done";

export const TASK_STATUSES: TaskStatus[] = [
  "planned",
  "todo",
  "in_progress",
  "in_review",
  "ready_to_test",
  "done",
];

export const DIFFICULTIES: Difficulty[] = ["S", "M", "L", "XL"];
export const CATEGORIES: Category[] = ["bug", "doc", "user-story", "idea"];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  planned: "Planned",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
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
  role: UserRole;
  allowedProjects: Types.ObjectId[];
  createdAt: Date;
}

export interface ILabel {
  _id: Types.ObjectId;
  name: string;
  color: string;
}

export interface IProject {
  _id: Types.ObjectId;
  name: string;
  key: string;
  description: string;
  components: string[];
  labels: ILabel[];
  githubRepo: string;
  taskCounter: number;
  owner: Types.ObjectId | IUser;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITask {
  _id: Types.ObjectId;
  project: Types.ObjectId | IProject;
  taskNumber: number;
  title: string;
  description: string;
  difficulty: Difficulty;
  component: string;
  category: Category;
  status: TaskStatus;
  assignee: Types.ObjectId | IUser | null;
  acceptanceCriteria: string;
  labels: Types.ObjectId[];
  pinned: boolean;
  blockedBy: (Types.ObjectId | ITask)[];
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
  role: UserRole;
  allowedProjects: string[];
  createdAt: string;
}

export interface ApiLabel {
  _id: string;
  name: string;
  color: string;
}

export interface ApiProject {
  _id: string;
  name: string;
  key: string;
  description: string;
  components: string[];
  labels: ApiLabel[];
  githubRepo: string;
  taskCounter: number;
  owner: ApiUser | string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiTaskLink {
  _id: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
}

export interface ApiTask {
  _id: string;
  project: string;
  taskKey: string;
  taskNumber: number;
  title: string;
  description: string;
  difficulty: Difficulty;
  component: string;
  category: Category;
  status: TaskStatus;
  assignee: ApiUser | null;
  acceptanceCriteria: string;
  labels: string[];
  pinned: boolean;
  blockedBy: ApiTaskLink[];
  blocking: ApiTaskLink[];
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
export type SortField = "updatedAt" | "createdAt" | "difficulty" | "category" | "title";
export type SortDir = "asc" | "desc";

export const SORT_OPTIONS: { value: SortField; label: string; defaultDir: SortDir }[] = [
  { value: "updatedAt", label: "Last updated", defaultDir: "desc" },
  { value: "createdAt", label: "Created", defaultDir: "desc" },
  { value: "difficulty", label: "Difficulty", defaultDir: "asc" },
  { value: "category", label: "Category", defaultDir: "asc" },
  { value: "title", label: "Title", defaultDir: "asc" },
];

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

// Parsed markdown task for import
export interface ParsedTask {
  title: string;
  category: Category;
  component?: string;
  difficulty?: Difficulty;
  status?: TaskStatus;
  assignee?: string;
  description?: string;
  acceptanceCriteria?: string;
}
