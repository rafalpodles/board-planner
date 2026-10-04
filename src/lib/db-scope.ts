import { Types, type HydratedDocument, type Model } from "mongoose";
import { ActivityLog } from "@/models/activityLog";
import { Agent } from "@/models/agent";
import { AgentBlock } from "@/models/agentBlock";
import { AgentRun } from "@/models/agentRun";
import { ApiToken } from "@/models/apiToken";
import { Comment } from "@/models/comment";
import { DeviceEnrolment } from "@/models/deviceEnrolment";
import { EmailChangeToken } from "@/models/emailChangeToken";
import { EnrolmentToken } from "@/models/enrolmentToken";
import { Grant } from "@/models/grant";
import { Identity } from "@/models/identity";
import { InstanceAuditLog } from "@/models/instanceAuditLog";
import { Invitation } from "@/models/invitation";
import { Notification } from "@/models/notification";
import { OAuthClient } from "@/models/oauthClient";
import { OAuthCode } from "@/models/oauthCode";
import { OAuthConsent } from "@/models/oauthConsent";
import { OAuthToken } from "@/models/oauthToken";
import { OidcFlow } from "@/models/oidcFlow";
import { PasswordResetToken } from "@/models/passwordResetToken";
import { PmMessage } from "@/models/pmMessage";
import { PmOauthState } from "@/models/pmOauthState";
import { PmTrigger } from "@/models/pmTrigger";
import { Project } from "@/models/project";
import { ProjectAuditLog } from "@/models/projectAuditLog";
import { Session } from "@/models/session";
import { Settings } from "@/models/settings";
import { Sprint } from "@/models/sprint";
import { Task } from "@/models/task";
import { User } from "@/models/user";
import { Worker } from "@/models/worker";
import { DEFAULT_TENANT_ID } from "./tenant-field";

// Thunks: a test that mocks one model must not fail on the exports of the others
export const SCOPED_MODELS = {
  ActivityLog: () => ActivityLog,
  Agent: () => Agent,
  AgentBlock: () => AgentBlock,
  AgentRun: () => AgentRun,
  ApiToken: () => ApiToken,
  Comment: () => Comment,
  DeviceEnrolment: () => DeviceEnrolment,
  EmailChangeToken: () => EmailChangeToken,
  EnrolmentToken: () => EnrolmentToken,
  Grant: () => Grant,
  Identity: () => Identity,
  InstanceAuditLog: () => InstanceAuditLog,
  Invitation: () => Invitation,
  Notification: () => Notification,
  OAuthClient: () => OAuthClient,
  OAuthCode: () => OAuthCode,
  OAuthConsent: () => OAuthConsent,
  OAuthToken: () => OAuthToken,
  OidcFlow: () => OidcFlow,
  PasswordResetToken: () => PasswordResetToken,
  PmMessage: () => PmMessage,
  PmOauthState: () => PmOauthState,
  PmTrigger: () => PmTrigger,
  Project: () => Project,
  ProjectAuditLog: () => ProjectAuditLog,
  Session: () => Session,
  Settings: () => Settings,
  Sprint: () => Sprint,
  Task: () => Task,
  User: () => User,
  Worker: () => Worker,
} as const;

const SAFE_METHODS = [
  "find",
  "findOne",
  "findById",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "findOneAndDelete",
  "findByIdAndDelete",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "countDocuments",
  "exists",
  "distinct",
  "create",
  "insertMany",
  "aggregate",
  "bulkWrite",
] as const;

/** The Mongoose call signatures a handler may use: every one is confined to the caller's tenant. */
export type ScopedModel<M> = M extends Model<infer T>
  ? Pick<M, (typeof SAFE_METHODS)[number]> & {
      /** `new Model(doc)` with the tenant set, for the code that builds a document and saves it. */
      build(doc?: Partial<T>): HydratedDocument<T>;
    }
  : never;

export type ScopedDb = { [K in keyof typeof SCOPED_MODELS]: ScopedModel<ReturnType<(typeof SCOPED_MODELS)[K]>> };

export class TenantKeyError extends Error {
  constructor(where: string) {
    super(`${where} names a tenant. A scoped model sets the tenant itself; it is never the caller's to choose.`);
    this.name = "TenantKeyError";
  }
}

export class UnscopableError extends Error {
  constructor(what: string) {
    super(`${what} cannot be scoped to a tenant here.`);
    this.name = "UnscopableError";
  }
}

type Doc = Record<string, unknown>;

const isDoc = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Types.ObjectId);

function scopeFilter(filter: unknown, tenant: Types.ObjectId): Doc {
  if (filter === undefined || filter === null) return { tenant };
  if (!isDoc(filter)) throw new UnscopableError("A filter that is not an object");
  if ("tenant" in filter) throw new TenantKeyError("A filter");
  return { ...filter, tenant };
}

function checkUpdate(update: unknown): unknown {
  if (update === undefined || update === null) return update;
  if (Array.isArray(update)) throw new UnscopableError("An update pipeline");
  if (!isDoc(update)) return update;
  if ("tenant" in update) throw new TenantKeyError("An update");
  for (const [key, value] of Object.entries(update)) {
    if (!key.startsWith("$") || !isDoc(value)) continue;
    if ("tenant" in value) throw new TenantKeyError(`An update's ${key}`);
    if (key === "$rename" && Object.values(value).includes("tenant")) throw new TenantKeyError("An update's $rename");
  }
  return update;
}

function stamp(doc: unknown, tenant: Types.ObjectId): Doc {
  if (!isDoc(doc)) throw new UnscopableError("A document that is not an object");
  if ("tenant" in doc) throw new TenantKeyError("A document");
  return { ...doc, tenant };
}

function stampCreate(given: unknown[], tenant: Types.ObjectId): unknown[] {
  const args = [...given];
  while (args.length > 1 && (args[args.length - 1] === undefined || args[args.length - 1] === null)) args.pop();
  const [first, ...rest] = args;
  if (Array.isArray(first)) return [first.map((doc) => stamp(doc, tenant)), ...rest];
  return args.map((doc) => stamp(doc, tenant));
}

const stampAll = (docs: unknown, tenant: Types.ObjectId) =>
  Array.isArray(docs) ? docs.map((doc) => stamp(doc, tenant)) : stamp(docs, tenant);

const FOREIGN_STAGES = ["$lookup", "$graphLookup", "$unionWith", "$merge", "$out"];

function refuseForeignStages(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(refuseForeignStages);
  if (!isDoc(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (FOREIGN_STAGES.includes(key)) throw new UnscopableError(`The ${key} stage`);
    refuseForeignStages(value);
  }
}

function scopePipeline(pipeline: unknown, tenant: Types.ObjectId): Doc[] {
  if (!Array.isArray(pipeline)) throw new UnscopableError("A pipeline that is not an array");
  refuseForeignStages(pipeline);
  return [{ $match: { tenant } }, ...pipeline];
}

const BULK_FILTERED = ["updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne"];

function scopeBulk(operations: unknown, tenant: Types.ObjectId): Doc[] {
  if (!Array.isArray(operations)) throw new UnscopableError("Bulk operations that are not an array");
  return operations.map((operation) => {
    if (!isDoc(operation)) throw new UnscopableError("A bulk operation that is not an object");
    const [name] = Object.keys(operation);
    const body = operation[name];
    if (!isDoc(body)) throw new UnscopableError(`The ${name} bulk operation`);
    if (name === "insertOne") return { insertOne: { ...body, document: stamp(body.document, tenant) } };
    if (BULK_FILTERED.includes(name)) {
      const scoped: Doc = { ...body, filter: scopeFilter(body.filter, tenant) };
      if ("update" in body) scoped.update = checkUpdate(body.update);
      if ("replacement" in body) scoped.replacement = stamp(body.replacement, tenant);
      return { [name]: scoped };
    }
    throw new UnscopableError(`The ${name} bulk operation`);
  });
}

type Loose = (...args: unknown[]) => unknown;

function scopeModel(model: Model<never>, tenant: Types.ObjectId): unknown {
  const raw = model as unknown as Record<string, Loose>;
  const call = (method: string, ...args: unknown[]) => raw[method].call(model, ...args);
  const byId = (id: unknown) => scopeFilter({ _id: id ?? null }, tenant);

  const methods: Record<string, Loose> = {
    find: (filter, ...rest) => call("find", scopeFilter(filter, tenant), ...rest),
    findOne: (filter, ...rest) => call("findOne", scopeFilter(filter, tenant), ...rest),
    findById: (id, ...rest) => call("findOne", byId(id), ...rest),
    findOneAndUpdate: (filter, update, ...rest) =>
      call("findOneAndUpdate", scopeFilter(filter, tenant), checkUpdate(update), ...rest),
    findByIdAndUpdate: (id, update, ...rest) =>
      call("findOneAndUpdate", byId(id), checkUpdate(update), ...rest),
    findOneAndDelete: (filter, ...rest) => call("findOneAndDelete", scopeFilter(filter, tenant), ...rest),
    findByIdAndDelete: (id, ...rest) => call("findOneAndDelete", byId(id), ...rest),
    updateOne: (filter, update, ...rest) => call("updateOne", scopeFilter(filter, tenant), checkUpdate(update), ...rest),
    updateMany: (filter, update, ...rest) =>
      call("updateMany", scopeFilter(filter, tenant), checkUpdate(update), ...rest),
    deleteOne: (filter, ...rest) => call("deleteOne", scopeFilter(filter, tenant), ...rest),
    deleteMany: (filter, ...rest) => call("deleteMany", scopeFilter(filter, tenant), ...rest),
    countDocuments: (filter, ...rest) => call("countDocuments", scopeFilter(filter, tenant), ...rest),
    exists: (filter) => call("exists", scopeFilter(filter, tenant)),
    distinct: (field, filter, ...rest) => call("distinct", field, scopeFilter(filter, tenant), ...rest),
    create: (...args) => call("create", ...stampCreate(args, tenant)),
    insertMany: (docs, ...rest) => call("insertMany", stampAll(docs, tenant), ...rest),
    aggregate: (pipeline, ...rest) => call("aggregate", scopePipeline(pipeline, tenant), ...rest),
    bulkWrite: (operations, ...rest) => call("bulkWrite", scopeBulk(operations, tenant), ...rest),
    build: (doc) => new (model as unknown as new (doc: unknown) => unknown)(stamp(doc ?? {}, tenant)),
  };
  return methods;
}

const cache = new Map<string, ScopedDb>();

export function scoped(tenant: Types.ObjectId | string): ScopedDb {
  const id = new Types.ObjectId(String(tenant));
  const key = id.toHexString();
  const cached = cache.get(key);
  if (cached) return cached;

  const built = new Map<string, unknown>();
  const db = new Proxy({} as ScopedDb, {
    get(_target, name) {
      if (typeof name !== "string" || !Object.hasOwn(SCOPED_MODELS, name)) return undefined;
      if (!built.has(name)) {
        built.set(name, scopeModel(SCOPED_MODELS[name as keyof typeof SCOPED_MODELS]() as unknown as Model<never>, id));
      }
      return built.get(name);
    },
  });
  cache.set(key, db);
  return db;
}

// TODO(BP-664): a caller with no tenant must be refused, not placed in the default one
export function tenantOf(user: { tenant?: Types.ObjectId | string | null }): Types.ObjectId {
  return user.tenant ? new Types.ObjectId(String(user.tenant)) : DEFAULT_TENANT_ID;
}

export const scopedFor = (user: { tenant?: Types.ObjectId | string | null }): ScopedDb => scoped(tenantOf(user));

// TODO(BP-664): a request with no caller yet takes its tenant from the host; until then there is one
export const scopedToDefaultTenant = (): ScopedDb => scoped(DEFAULT_TENANT_ID);
