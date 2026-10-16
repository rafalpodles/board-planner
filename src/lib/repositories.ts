import { Types } from "mongoose";
import { projectRepositoryUrl, type RepositoryFields } from "./repository";

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

type WithRepositories = RepositoryFields & { repositories?: StoredRepository[] | null };

/**
 * The project's repositories, the first being the one everything still reads today. A project the
 * migration has not reached yet has none stored, and its single repository is derived from the
 * fields it does have, under a stable id that is not an ObjectId so it can never collide.
 */
export function projectRepositories(project: WithRepositories): ProjectRepository[] {
  const stored = (project.repositories ?? []).filter((r) => r.url?.trim());
  if (stored.length > 0) {
    return stored.map((r) => ({ id: String(r._id), url: r.url.trim(), name: r.name?.trim() ?? "" }));
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
