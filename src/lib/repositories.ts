import { Types } from "mongoose";
import { hasControlCharacters } from "./identifiers";
import { normaliseRemote } from "./repo-match";
import { MAX_ADDITIONAL_REPOSITORIES } from "./repository-limits";
import { entryId, projectRepositoryUrl, storedRepositories, type RepositoryEntry, type RepositoryFields } from "./repository";

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


export interface AdditionalRepository {
  url: string;
  name: string;
}

/**
 * The repositories after the primary one, as a person typed them. The primary is not in this list: it
 * is `repositoryUrl`, and it has to exist before anything follows it.
 */
export function parseAdditionalRepositories(
  value: unknown,
  primaryUrl: string
): { value: AdditionalRepository[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "additionalRepositories must be a list" };
  if (value.length > MAX_ADDITIONAL_REPOSITORIES) {
    return { error: `a project can list at most ${MAX_ADDITIONAL_REPOSITORIES + 1} repositories` };
  }
  if (value.length > 0 && !primaryUrl.trim()) {
    return { error: "set the repository URL before adding more repositories" };
  }
  const seen = [normaliseRemote(primaryUrl)];
  const parsed: AdditionalRepository[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `additionalRepositories[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { error: `${at} must be an object` };
    const { url, name = "" } = entry as { url?: unknown; name?: unknown };
    if (typeof url !== "string" || typeof name !== "string") return { error: `${at} needs a text url and a text name` };
    const address = url.trim();
    const label = name.trim();
    if (!address) return { error: `${at}.url is empty` };
    if (address.length > MAX_REPOSITORY_URL_LENGTH || hasControlCharacters(address)) {
      return { error: `${at}.url is not a valid address` };
    }
    if (label.length > REPOSITORY_NAME_MAX_LENGTH || hasControlCharacters(label)) {
      return { error: `${at}.name must be at most ${REPOSITORY_NAME_MAX_LENGTH} characters, on one line` };
    }
    const identity = normaliseRemote(address);
    if (!identity) return { error: `${at}.url does not name a repository` };
    if (seen.includes(identity)) return { error: `${at}.url is already listed: ${address}` };
    seen.push(identity);
    parsed.push({ url: address, name: label });
  }
  return { value: parsed };
}

/**
 * The list with the entries after the primary replaced. An address that was listed keeps its id, so
 * whatever names the entry (a machine's binding) still names the same one after a rename.
 */
export function withAdditionalRepositories(
  stored: StoredRepository[] | null | undefined,
  primaryUrl: string,
  additional: AdditionalRepository[]
): StoredRepository[] {
  const primary = stored?.[0] ?? { _id: new Types.ObjectId(), url: primaryUrl.trim(), name: "" };
  const before = (stored ?? []).slice(1);
  const rest = additional.map((entry) => {
    const same = before.find((each) => normaliseRemote(each.url) === normaliseRemote(entry.url));
    return { _id: same?._id ?? new Types.ObjectId(), url: entry.url, name: entry.name };
  });
  return [primary, ...rest];
}

/** What an audit entry says about the entries after the primary, which `repositoryUrl` does not cover */
export function describeRepositoryChanges(
  before: RepositoryEntry[] | null | undefined,
  after: RepositoryEntry[] | null | undefined
): string[] {
  const rest = (list: RepositoryEntry[] | null | undefined) => (list ?? []).slice(1).filter((r) => r.url?.trim());
  const was = rest(before);
  const now = rest(after);
  const keyOf = (r: RepositoryEntry) => normaliseRemote(r.url);
  const lines: string[] = [];
  for (const entry of now) {
    const old = was.find((r) => keyOf(r) === keyOf(entry));
    if (!old) lines.push(`Added repository ${entry.url.trim()}${entry.name?.trim() ? ` (${entry.name.trim()})` : ""}`);
    else if ((old.name ?? "").trim() !== (entry.name ?? "").trim()) {
      lines.push(`Renamed repository ${entry.url.trim()} to "${(entry.name ?? "").trim()}"`);
    }
  }
  for (const old of was) {
    if (!now.some((r) => keyOf(r) === keyOf(old))) lines.push(`Removed repository ${old.url.trim()}`);
  }
  return lines;
}
