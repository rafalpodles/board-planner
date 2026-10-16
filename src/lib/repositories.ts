import { Types } from "mongoose";
import { entryId, projectRepositoryUrl, storedRepositories, type RepositoryEntry, type RepositoryFields } from "./repository";
import { echo } from "./echo";

export const REPOSITORY_NAME_MAX_LENGTH = 100;
export const MAX_REPOSITORY_URL_LENGTH = 2048;

export interface StoredRepository {
  _id: Types.ObjectId;
  url: string;
  name?: string;
}

export interface ProjectRepository {
  id: string;
  url: string;
  name: string;
}

type WithRepositories = RepositoryFields & { repositories?: RepositoryEntry[] | null };

/**
 * The project's repositories, the first being the one everything still reads today. A project the
 * migration has not reached yet has none stored, and its single repository is derived from the
 * fields it does have, under a stable id that is not an ObjectId so it can never collide.
 */
export function projectRepositories(project: WithRepositories): ProjectRepository[] {
  const stored = (project.repositories ?? []).filter((r) => r.url?.trim());
  if (stored.length > 0) {
    return stored.map((r) => ({ id: entryId(r), url: r.url.trim(), name: r.name?.trim() ?? "" }));
  }
  const url = projectRepositoryUrl(project);
  return url ? [{ id: "primary", url, name: "" }] : [];
}

/**
 * The list after the primary repository's address changes, keeping its id so whatever names it
 * (a task, a machine's binding) still names the same entry. An empty address leaves no primary.
 */
export function withPrimaryUrl(stored: StoredRepository[] | null | undefined, url: string): StoredRepository[] {
  const rest = (stored ?? []).slice(1);
  const trimmed = url.trim();
  if (!trimmed) return rest;
  const first = stored?.[0];
  return [{ _id: first?._id ?? new Types.ObjectId(), url: trimmed, name: first?.name ?? "" }, ...rest];
}

export function hasSeveralRepositories(project: WithRepositories): boolean {
  return storedRepositories(project).length > 1;
}

/**
 * Why this value cannot be written to a task's `repository`, or null when it can. Only a stored
 * entry is nameable: the derived `primary` of a project the migration has not reached would dangle
 * the moment it does.
 */
export function repositoryRefusal(project: WithRepositories, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const entries = storedRepositories(project);
  if (typeof value === "string" && entries.some((r) => entryId(r) === value)) return null;
  if (entries.length === 0) return "This project names no repository to choose from";
  const known = entries
    .map((r) => `${entryId(r)} (${(r.name?.trim() || r.url).slice(0, 80)})`)
    .join(", ");
  return `Unknown repository "${echo(value)}" — this project's repositories: ${known}`;
}

/** What the history shows for a repository id: its name or address, the id itself once it is gone */
export function repositoryNameOf(project: WithRepositories, id: unknown): string | null {
  if (!id) return null;
  const entry = storedRepositories(project).find((r) => entryId(r) === String(id));
  return (entry?.name?.trim() || entry?.url.trim() || String(id)).slice(0, 200);
}

/**
 * The entry a caller means by an id, a name or an address, or why it cannot be told. Empty clears.
 * Names are not unique, so one two entries share is refused with their ids rather than answered
 * for whichever came first.
 */
export function repositoryIdFor(
  project: WithRepositories,
  ref: string
): { id: string | null } | { error: string } {
  const wanted = ref.trim();
  if (wanted === "") return { id: null };
  const entries = storedRepositories(project);
  const byId = entries.find((r) => entryId(r) === wanted);
  if (byId) return { id: entryId(byId) };
  const lower = wanted.toLowerCase();
  const matches = entries.filter((r) => (r.name ?? "").trim().toLowerCase() === lower || r.url.trim().toLowerCase() === lower);
  if (matches.length === 1) return { id: entryId(matches[0]) };
  const list = entries.map((r) => `${(r.name?.trim() || r.url).slice(0, 80)} (${entryId(r)})`).join(", ") || "none";
  if (matches.length > 1) return { error: `More than one repository is called "${echo(wanted)}" — use an id. Repositories: ${list}` };
  return { error: `No repository "${echo(wanted)}" on this board, by name, address or id. Repositories: ${list}` };
}
