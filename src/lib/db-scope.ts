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
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { expectOrganisation } from "./organisation-wall";

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

/** The Mongoose call signatures a handler may use: every one is confined to the caller's organisation. */
export type ScopedModel<M> = M extends Model<infer T>
  ? Pick<M, (typeof SAFE_METHODS)[number]> & {
      /** `new Model(doc)` with the organisation set, for the code that builds a document and saves it. */
      build(doc?: Partial<T>): HydratedDocument<T>;
    }
  : never;

export type ScopedDb = { readonly organisation: Types.ObjectId } & {
  [K in keyof typeof SCOPED_MODELS]: ScopedModel<ReturnType<(typeof SCOPED_MODELS)[K]>>;
};

export class OrganisationKeyError extends Error {
  constructor(where: string) {
    super(`${where} names an organisation. A scoped model sets the organisation itself; it is never the caller's to choose.`);
    this.name = "OrganisationKeyError";
  }
}

export class UnscopableError extends Error {
  constructor(what: string) {
    super(`${what} cannot be scoped to an organisation here.`);
    this.name = "UnscopableError";
  }
}

type Doc = Record<string, unknown>;

const isDoc = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Types.ObjectId);

function scopeFilter(filter: unknown, organisation: Types.ObjectId): Doc {
  if (filter === undefined || filter === null) return { organisation };
  if (!isDoc(filter)) throw new UnscopableError("A filter that is not an object");
  if ("organisation" in filter) throw new OrganisationKeyError("A filter");
  return { ...filter, organisation };
}

function checkUpdate(update: unknown): unknown {
  if (update === undefined || update === null) return update;
  if (Array.isArray(update)) throw new UnscopableError("An update pipeline");
  if (!isDoc(update)) return update;
  if ("organisation" in update) throw new OrganisationKeyError("An update");
  for (const [key, value] of Object.entries(update)) {
    if (!key.startsWith("$") || !isDoc(value)) continue;
    if ("organisation" in value) throw new OrganisationKeyError(`An update's ${key}`);
    if (key === "$rename" && Object.values(value).includes("organisation")) throw new OrganisationKeyError("An update's $rename");
  }
  return update;
}

function stamp(doc: unknown, organisation: Types.ObjectId): Doc {
  if (!isDoc(doc)) throw new UnscopableError("A document that is not an object");
  if ("organisation" in doc) throw new OrganisationKeyError("A document");
  return { ...doc, organisation };
}

function stampCreate(given: unknown[], organisation: Types.ObjectId): unknown[] {
  const args = [...given];
  while (args.length > 1 && (args[args.length - 1] === undefined || args[args.length - 1] === null)) args.pop();
  const [first, ...rest] = args;
  if (Array.isArray(first)) return [first.map((doc) => stamp(doc, organisation)), ...rest];
  return args.map((doc) => stamp(doc, organisation));
}

const stampAll = (docs: unknown, organisation: Types.ObjectId) =>
  Array.isArray(docs) ? docs.map((doc) => stamp(doc, organisation)) : stamp(docs, organisation);

const FOREIGN_STAGES = ["$lookup", "$graphLookup", "$unionWith", "$merge", "$out"];

function refuseForeignStages(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(refuseForeignStages);
  if (!isDoc(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (FOREIGN_STAGES.includes(key)) throw new UnscopableError(`The ${key} stage`);
    refuseForeignStages(value);
  }
}

function scopePipeline(pipeline: unknown, organisation: Types.ObjectId): Doc[] {
  if (!Array.isArray(pipeline)) throw new UnscopableError("A pipeline that is not an array");
  refuseForeignStages(pipeline);
  return [{ $match: { organisation } }, ...pipeline];
}

const BULK_FILTERED = ["updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne"];

function scopeBulk(operations: unknown, organisation: Types.ObjectId): Doc[] {
  if (!Array.isArray(operations)) throw new UnscopableError("Bulk operations that are not an array");
  return operations.map((operation) => {
    if (!isDoc(operation)) throw new UnscopableError("A bulk operation that is not an object");
    const [name] = Object.keys(operation);
    const body = operation[name];
    if (!isDoc(body)) throw new UnscopableError(`The ${name} bulk operation`);
    if (name === "insertOne") return { insertOne: { ...body, document: stamp(body.document, organisation) } };
    if (BULK_FILTERED.includes(name)) {
      const scoped: Doc = { ...body, filter: scopeFilter(body.filter, organisation) };
      if ("update" in body) scoped.update = checkUpdate(body.update);
      if ("replacement" in body) scoped.replacement = stamp(body.replacement, organisation);
      return { [name]: scoped };
    }
    throw new UnscopableError(`The ${name} bulk operation`);
  });
}

type Loose = (...args: unknown[]) => unknown;

type PopulateOptions = { path?: string; match?: unknown; populate?: unknown };

function confineNested(nested: unknown, organisation: Types.ObjectId): unknown {
  if (typeof nested === "string") return nested.split(/\s+/).filter(Boolean).map((path) => confine({ path }, organisation));
  if (Array.isArray(nested)) return nested.flatMap((item) => confineNested(item, organisation));
  if (isDoc(nested)) return confine({ ...(nested as PopulateOptions) }, organisation);
  return nested;
}

// For a populate on a query the scoped db did not build: the paths, each confined to the organisation
export const populateWithin = (paths: unknown, organisation: Types.ObjectId): unknown => confineNested(paths, organisation);

function confine<O extends PopulateOptions>(options: O, organisation: Types.ObjectId): O {
  const match = options.match;
  options.match =
    typeof match === "function"
      ? function (this: unknown, ...args: unknown[]) {
          return { ...((match as Loose).apply(this, args) as Doc | undefined), organisation };
        }
      : { ...(isDoc(match) ? match : {}), organisation };
  if (options.populate !== undefined) options.populate = confineNested(options.populate, organisation);
  return options;
}

type ScopedQuery = { populate?: Loose; _mongooseOptions?: { populate?: Record<string, PopulateOptions> } };

function bind(result: unknown, organisation: Types.ObjectId): unknown {
  if (typeof result !== "object" || result === null) return result;
  expectOrganisation(result, organisation);
  const query = result as ScopedQuery;
  const populate = query.populate;
  if (typeof populate === "function") {
    query.populate = function (this: ScopedQuery, ...args: unknown[]) {
      const returned = populate.apply(this, args);
      for (const options of Object.values(this._mongooseOptions?.populate ?? {})) confine(options, organisation);
      return returned;
    };
  }
  return result;
}

function scopeModel(model: Model<never>, organisation: Types.ObjectId): unknown {
  const raw = model as unknown as Record<string, Loose>;
  const call = (method: string, ...args: unknown[]) => bind(raw[method].call(model, ...args), organisation);
  const byId = (id: unknown) => scopeFilter({ _id: id ?? null }, organisation);

  const methods: Record<string, Loose> = {
    find: (filter, ...rest) => call("find", scopeFilter(filter, organisation), ...rest),
    findOne: (filter, ...rest) => call("findOne", scopeFilter(filter, organisation), ...rest),
    findById: (id, ...rest) => call("findOne", byId(id), ...rest),
    findOneAndUpdate: (filter, update, ...rest) =>
      call("findOneAndUpdate", scopeFilter(filter, organisation), checkUpdate(update), ...rest),
    findByIdAndUpdate: (id, update, ...rest) =>
      call("findOneAndUpdate", byId(id), checkUpdate(update), ...rest),
    findOneAndDelete: (filter, ...rest) => call("findOneAndDelete", scopeFilter(filter, organisation), ...rest),
    findByIdAndDelete: (id, ...rest) => call("findOneAndDelete", byId(id), ...rest),
    updateOne: (filter, update, ...rest) => call("updateOne", scopeFilter(filter, organisation), checkUpdate(update), ...rest),
    updateMany: (filter, update, ...rest) =>
      call("updateMany", scopeFilter(filter, organisation), checkUpdate(update), ...rest),
    deleteOne: (filter, ...rest) => call("deleteOne", scopeFilter(filter, organisation), ...rest),
    deleteMany: (filter, ...rest) => call("deleteMany", scopeFilter(filter, organisation), ...rest),
    countDocuments: (filter, ...rest) => call("countDocuments", scopeFilter(filter, organisation), ...rest),
    exists: (filter) => call("exists", scopeFilter(filter, organisation)),
    distinct: (field, filter, ...rest) => call("distinct", field, scopeFilter(filter, organisation), ...rest),
    create: (...args) => call("create", ...stampCreate(args, organisation)),
    insertMany: (docs, ...rest) => call("insertMany", stampAll(docs, organisation), ...rest),
    aggregate: (pipeline, ...rest) => call("aggregate", scopePipeline(pipeline, organisation), ...rest),
    bulkWrite: (operations, ...rest) => call("bulkWrite", scopeBulk(operations, organisation), ...rest),
    build: (doc) => new (model as unknown as new (doc: unknown) => unknown)(stamp(doc ?? {}, organisation)),
  };
  return methods;
}

const cache = new Map<string, ScopedDb>();

export function scoped(organisation: Types.ObjectId | string): ScopedDb {
  const id = new Types.ObjectId(String(organisation));
  const key = id.toHexString();
  const cached = cache.get(key);
  if (cached) return cached;

  const built = new Map<string, unknown>();
  const db = new Proxy({ organisation: id } as ScopedDb, {
    get(target, name) {
      if (name === "organisation") return target.organisation;
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

export function organisationOf(user: { organisation?: Types.ObjectId | string | null }): Types.ObjectId {
  return user.organisation ? new Types.ObjectId(String(user.organisation)) : DEFAULT_ORGANISATION_ID;
}

export const scopedFor = (user: { organisation?: Types.ObjectId | string | null }): ScopedDb => scoped(organisationOf(user));

// TODO(BP-895): the OIDC relay finds its flow in the default organisation until it looks across organisations
export const scopedToDefaultOrganisation = (): ScopedDb => scoped(DEFAULT_ORGANISATION_ID);

export async function scopedForRequest(request: Request): Promise<ScopedDb | null> {
  const { organisationOfRequest } = await import("./organisation-host");
  const host = await organisationOfRequest(request);
  return host.kind === "organisation" ? scoped(host.organisation) : null;
}

