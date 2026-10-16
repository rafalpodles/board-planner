// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
import type { ScopedDb } from "@/lib/db-scope";
import type { ICustomField, ITask, ITriageSuggestion } from "@/types";
import { gatewayWrite } from "@/lib/ai-gateway";
import { resolveAiModel } from "@/lib/pm/availability";
import { getPmUser } from "@/lib/pm/pm-user";
import { projectAudienceFilter } from "@/lib/grants";
import { getOrganisation } from "@/lib/organisation";
import { can } from "@/lib/entitlements";
import { stillServed } from "@/lib/organisation-jobs";
import { actingThrough } from "@/lib/activity-source";
import { updateTask, type TaskServiceResult } from "@/lib/task-service";
import { NOT_ARCHIVED } from "@/lib/task-archive";
import { orderedOptions } from "@/lib/custom-fields";
import { outsideGeneratedBy } from "@/lib/ai-generated";

export const TRIAGE_MAX_ATTEMPTS = 3;
export const TRIAGE_CLAIM_STALE_MS = 10 * 60_000;
const MAX_PEOPLE = 50;
const RECENT_WORK_PER_PERSON = 3;
const DESCRIPTION_MAX = 2000;
const REASON_MAX = 300;

export interface TriageMaterial {
  task: { title: string; description: string };
  ask: { assignee: boolean; category: boolean; fieldIds: string[] };
  people: { username: string; name: string; recentWork: string[] }[];
  categories: string[];
  fields: { id: string; name: string; options: { id: string; label: string }[] }[];
}

function fieldValues(task: Pick<ITask, "customFieldValues">): Record<string, unknown> {
  const values: unknown = task.customFieldValues;
  if (values instanceof Map) return Object.fromEntries(values);
  return { ...((values as Record<string, unknown> | undefined) ?? {}) };
}

type Suggestion = Pick<ITriageSuggestion, "field" | "fieldId" | "value" | "reason">;

function singleChoiceFields(fields: ICustomField[] | undefined): ICustomField[] {
  return (fields ?? []).filter((f) => f.fieldType === "dropdown" && !f.archived && orderedOptions(f).length > 0);
}

export async function triageMaterial(db: ScopedDb, task: ITask): Promise<TriageMaterial | null> {
  const project = await db.Project.findById(task.project, "categories customFields").lean();
  if (!project) return null;
  const explicit = new Set(task.triage?.explicit ?? []);
  const values = fieldValues(task);
  const fields = singleChoiceFields(project.customFields).filter((f) => !explicit.has(`custom:${f._id}`) && !values[String(f._id)]);
  const ask = {
    assignee: !task.assignee && !explicit.has("assignee"),
    // Asked even when the creator sent one: the task form always sends a category, so only auto-apply
    // holds back from an explicit one
    category: (project.categories?.length ?? 0) > 1,
    fieldIds: fields.map((f) => String(f._id)),
  };
  if (!ask.assignee && !ask.category && ask.fieldIds.length === 0) return null;

  const people = ask.assignee
    ? await db.User.find({ ...(await projectAudienceFilter(db, String(task.project))), kind: { $ne: "machine" }, deactivatedAt: null }, "username fullName")
        .sort({ username: 1 })
        .limit(MAX_PEOPLE)
        .lean()
    : [];
  const recent = people.length
    ? await db.Task.find({ project: task.project, assignee: { $in: people.map((p) => p._id) }, _id: { $ne: task._id }, ...NOT_ARCHIVED }, "title assignee")
        .sort({ updatedAt: -1 })
        .limit(people.length * RECENT_WORK_PER_PERSON * 4)
        .lean()
    : [];
  const workOf = new Map<string, string[]>();
  for (const t of recent) {
    const list = workOf.get(String(t.assignee)) ?? [];
    if (list.length < RECENT_WORK_PER_PERSON) workOf.set(String(t.assignee), [...list, t.title]);
  }

  return {
    task: { title: task.title, description: (task.description ?? "").slice(0, DESCRIPTION_MAX) },
    ask,
    people: people.map((p) => ({ username: p.username, name: p.fullName || p.username, recentWork: workOf.get(String(p._id)) ?? [] })),
    categories: ask.category ? (project.categories ?? []).map((c) => c.name) : [],
    fields: fields.map((f) => ({ id: String(f._id), name: f.name, options: orderedOptions(f).map((o) => ({ id: o.id, label: o.value })) })),
  };
}

export function triageInstructions(): string {
  return [
    "You triage a new task on a project board.",
    "Suggest only what `ask` asks for: an assignee from `people` (judge by their recentWork), a category from `categories`, and an option for each field in `fields`.",
    "Leave out anything you are unsure of. Give each suggestion a short reason, under 25 words, about the task, not about the person.",
    'Answer with JSON alone, no prose and no code fence: {"assignee":{"username":"…","reason":"…"}|null,"category":{"name":"…","reason":"…"}|null,"fields":[{"id":"…","option":"…","reason":"…"}]}',
    "Use only usernames, category names, field ids and option ids that appear in the data.",
  ].join("\n");
}

function reasonOf(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, REASON_MAX) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Only what names a member, a category or an option the board offered survives; everything else the model said is dropped. */
export function suggestionsFrom(text: string, material: TriageMaterial, currentCategory: string): Suggestion[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let answer: Record<string, unknown> | null;
  try {
    answer = asRecord(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return [];
  }
  if (!answer) return [];
  const out: Suggestion[] = [];

  const assignee = asRecord(answer.assignee);
  const username = typeof assignee?.username === "string" ? assignee.username.trim().toLowerCase() : "";
  if (material.ask.assignee && material.people.some((p) => p.username === username)) {
    out.push({ field: "assignee", value: username, reason: reasonOf(assignee?.reason) });
  }

  const category = asRecord(answer.category);
  const name = typeof category?.name === "string" ? category.name : "";
  if (material.ask.category && name !== currentCategory && material.categories.includes(name)) {
    out.push({ field: "category", value: name, reason: reasonOf(category?.reason) });
  }

  const seen = new Set<string>();
  for (const raw of Array.isArray(answer.fields) ? answer.fields : []) {
    const item = asRecord(raw);
    const field = material.fields.find((f) => f.id === item?.id);
    if (!field || seen.has(field.id) || !material.ask.fieldIds.includes(field.id)) continue;
    const option = field.options.find((o) => o.id === item?.option) ?? field.options.find((o) => typeof item?.option === "string" && o.label.toLowerCase() === item.option.toLowerCase());
    if (!option) continue;
    seen.add(field.id);
    out.push({ field: "custom", fieldId: field.id, value: option.id, reason: reasonOf(item?.reason) });
  }
  return out;
}

function currentValue(task: Pick<ITask, "assignee" | "category" | "customFieldValues">, s: Pick<ITriageSuggestion, "field" | "fieldId">): string {
  if (s.field === "assignee") {
    const a = task.assignee as unknown as { username?: string } | null;
    return a?.username ?? "";
  }
  if (s.field === "category") return task.category ?? "";
  const value = fieldValues(task)[s.fieldId ?? ""];
  return typeof value === "string" ? value : "";
}

function bodyFor(task: Pick<ITask, "customFieldValues">, s: Pick<ITriageSuggestion, "field" | "fieldId">, value: string): Record<string, unknown> {
  if (s.field === "assignee") return { assignee: value || null };
  if (s.field === "category") return { category: value };
  const values = fieldValues(task);
  if (value) values[s.fieldId!] = value;
  else delete values[s.fieldId!];
  return { customFieldValues: values };
}

async function readTask(db: ScopedDb, taskId: string) {
  return db.Task.findOne({ _id: taskId, ...NOT_ARCHIVED }).populate("assignee", "username");
}

async function settle(db: ScopedDb, taskId: string, set: Record<string, unknown>) {
  await db.Task.updateOne({ _id: taskId }, { $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`triage.${k}`, v])) });
}

export async function runTriage(db: ScopedDb, taskId: string): Promise<void> {
  const task = await readTask(db, taskId);
  if (!task?.triage) return;
  const project = await db.Project.findById(task.project, "triageMode").lean();
  const organisation = await getOrganisation(db.organisation);
  if (!project || project.triageMode === "off" || !can(organisation, "ai.triage")) {
    await settle(db, taskId, { state: "ready", claimedAt: null });
    return;
  }

  const material = await triageMaterial(db, task);
  if (!material) {
    await settle(db, taskId, { state: "ready", claimedAt: null });
    return;
  }

  const asRead = { assignee: task.assignee, category: task.category, customFieldValues: fieldValues(task) } as unknown as Pick<ITask, "assignee" | "category" | "customFieldValues">;
  const written = await gatewayWrite(
    db,
    { projectId: String(task.project), userId: String(task.createdBy), source: "triage" },
    { model: await resolveAiModel(db), instructions: triageInstructions(), data: material }
  );
  if (!written.ok) {
    const spent = task.triage.attempts >= TRIAGE_MAX_ATTEMPTS;
    await settle(db, taskId, { state: spent ? "failed" : "pending", claimedAt: null });
    return;
  }

  const suggestions = suggestionsFrom(written.text, material, task.category);
  // `previous` is what the field held when the model read the task; auto-apply leaves a field that moved since
  await settle(db, taskId, { state: "ready", claimedAt: null, suggestions: suggestions.map((s) => ({ ...s, outcome: "open", previous: currentValue(asRead, s) })) });
  if (project.triageMode !== "auto" || suggestions.length === 0) return;

  const pm = await getPmUser(db);
  const stored = (await readTask(db, taskId))?.triage?.suggestions ?? [];
  const explicitCategory = task.triage.explicit.includes("category");
  for (const suggestion of stored) {
    if (suggestion.field === "category" && explicitCategory) continue;
    await applyOne(db, taskId, String(suggestion._id), String(pm._id), "apply", true).catch((err) =>
      console.error(`Triage could not apply its ${suggestion.field} suggestion:`, err)
    );
  }
}

export type TriageAction = "apply" | "dismiss" | "undo";

/**
 * One suggestion, by the person on the page or by triage itself. Triage's own apply leaves a field
 * that moved since the model read the task, and an undo one that moved since triage set it; a
 * person's apply is their own choice and overwrites.
 */
export async function applyOne(
  db: ScopedDb,
  taskId: string,
  suggestionId: string,
  actorId: string,
  action: TriageAction,
  byTriage = false
): Promise<TaskServiceResult | { ok: false; error: string; status: number } | { ok: true }> {
  const task = await readTask(db, taskId);
  const suggestion = task?.triage?.suggestions.find((s) => String(s._id) === suggestionId);
  if (!task || !suggestion) return { ok: false, error: "No such suggestion", status: 404 };
  const outcomeBefore = suggestion.outcome;

  const allowed: Record<TriageAction, string[]> = { apply: ["open"], dismiss: ["open"], undo: ["applied"] };
  if (!allowed[action].includes(outcomeBefore)) return { ok: false, error: `That suggestion was ${outcomeBefore} already`, status: 409 };

  const outcomeAt = (outcome: string, previous?: string | null) =>
    db.Task.updateOne(
      { _id: taskId, "triage.suggestions": { $elemMatch: { _id: suggestion._id, outcome: outcomeBefore } } },
      { $set: { "triage.suggestions.$.outcome": outcome, ...(previous !== undefined && { "triage.suggestions.$.previous": previous }) } }
    );

  if (action === "dismiss") {
    await outcomeAt("dismissed");
    return { ok: true };
  }

  const now = currentValue(task, suggestion);
  const target = action === "apply" ? suggestion.value : (suggestion.previous ?? "");
  if (action === "undo" && now !== suggestion.value) {
    return { ok: false, error: "The field has changed since triage set it; it is left as it is", status: 409 };
  }
  if (action === "apply" && byTriage && now !== (suggestion.previous ?? "")) {
    await outcomeAt("dismissed");
    return { ok: true };
  }

  const claimed = await outcomeAt(action === "apply" ? "applied" : "undone", action === "apply" ? now : undefined);
  if (claimed.modifiedCount === 0) return { ok: false, error: "That suggestion changed while this was saved", status: 409 };

  const write = () => updateTask(db, String(task.project), taskId, bodyFor(task, suggestion, target), actorId);
  const result = byTriage ? await actingThrough({ source: "ai-triage" }, write) : await write();
  if (!result.ok) {
    await db.Task.updateOne(
      { _id: taskId, "triage.suggestions._id": suggestion._id },
      { $set: { "triage.suggestions.$.outcome": outcomeBefore } }
    );
  }
  return result;
}

const waiting = (now: number) => ({
  $or: [{ "triage.state": "pending" as const }, { "triage.state": "running" as const, "triage.claimedAt": { $lt: new Date(now - TRIAGE_CLAIM_STALE_MS) } }],
});

export async function drainTriage(db: ScopedDb, { limit = 5, taskId }: { limit?: number; taskId?: string } = {}): Promise<void> {
  for (let run = 0; run < limit; run++) {
    if (!(await stillServed(db.organisation))) return;
    const now = Date.now();
    const claimed = await db.Task.findOneAndUpdate(
      { ...(taskId && { _id: taskId }), ...NOT_ARCHIVED, "triage.attempts": { $lt: TRIAGE_MAX_ATTEMPTS }, ...waiting(now) },
      { $set: { "triage.state": "running", "triage.claimedAt": new Date(now) }, $inc: { "triage.attempts": 1 } },
      { sort: { "triage.queuedAt": 1 }, projection: { _id: 1 } }
    );
    if (!claimed) break;
    // A task the PM agent created must not have triage's writes recorded as the PM's
    await outsideGeneratedBy(() => runTriage(db, String(claimed._id))).catch(async (err) => {
      console.error("Triage failed:", err);
      // Only a run that never stored its suggestions goes back in the queue
      await db.Task.updateOne({ _id: claimed._id, "triage.state": "running" }, { $set: { "triage.state": "pending", "triage.claimedAt": null } }).catch(() => {});
    });
  }
  const spent = await db.Task.updateMany(
    { "triage.attempts": { $gte: TRIAGE_MAX_ATTEMPTS }, ...waiting(Date.now()) },
    { $set: { "triage.state": "failed", "triage.claimedAt": null } }
  );
  if (spent.modifiedCount > 0) console.warn(`Triage gave up on ${spent.modifiedCount} task(s) after ${TRIAGE_MAX_ATTEMPTS} attempts`);
}
