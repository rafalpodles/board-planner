import { Types } from "mongoose";
import { hasControlCharacters } from "./identifiers";
import { parseRemote, sameRepo } from "./repo-match";
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
  const seen = [primaryUrl.trim()];
  const parsed: AdditionalRepository[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `Additional repository ${index + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { error: `${at} must be an object` };
    const { url, name = "" } = entry as { url?: unknown; name?: unknown };
    if (typeof url !== "string" || typeof name !== "string") return { error: `${at} needs a text address and a text name` };
    const address = url.trim();
    const label = name.trim();
    if (!address) return { error: `${at}: the address is empty` };
    if (address.length > MAX_REPOSITORY_URL_LENGTH || hasControlCharacters(address)) {
      return { error: `${at}: the address is not a valid address` };
    }
    if (label.length > REPOSITORY_NAME_MAX_LENGTH || hasControlCharacters(label)) {
      return { error: `${at}: the name must be at most ${REPOSITORY_NAME_MAX_LENGTH} characters, on one line` };
    }
    if (!parseRemote(address).repo) return { error: `${at}: the address does not name a repository` };
    if (seen.some((listed) => sameRepo(listed, address))) return { error: `${at}: ${address} is already listed` };
    seen.push(address);
    parsed.push({ url: address, name: label });
  }
  return { value: parsed };
}

/**
 * The list with the entries after the primary replaced. An address that was listed keeps its id, so
 * whatever names the entry (a machine's binding) still names the same one after a rename.
 */
// The same host and the same path: a host change is a different repository for a machine, though it is
// the same name on the page
function sameAddress(a: string, b: string): boolean {
  const left = parseRemote(a);
  const right = parseRemote(b);
  return left.repo !== "" && left.repo === right.repo && left.host === right.host;
}

export function withAdditionalRepositories(
  stored: StoredRepository[] | null | undefined,
  primaryUrl: string,
  additional: AdditionalRepository[]
): StoredRepository[] {
  const primary = stored?.[0] ?? { _id: new Types.ObjectId(), url: primaryUrl.trim(), name: "" };
  const before = (stored ?? []).slice(1);
  const rest = additional.map((entry) => {
    const same = before.find((each) => sameAddress(each.url, entry.url));
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
  const lines: string[] = [];
  for (const entry of now) {
    const old = was.find((r) => sameAddress(r.url, entry.url));
    if (!old) lines.push(`Added repository ${entry.url.trim()}${entry.name?.trim() ? ` (${entry.name.trim()})` : ""}`);
    else if ((old.name ?? "").trim() !== (entry.name ?? "").trim()) {
      lines.push(`Renamed repository ${entry.url.trim()} to "${(entry.name ?? "").trim()}"`);
    }
  }
  for (const old of was) {
    if (!now.some((r) => sameAddress(r.url, old.url))) lines.push(`Removed repository ${old.url.trim()}`);
  }
  return lines;
}

/**
 * The list a project saves after a request that moves the primary address, replaces the others, or
 * both — worked out as a whole and judged as a whole, so no combination leaves two entries for one
 * repository, promotes an extra into an emptied primary, or keeps entries behind a primary that is gone.
 */
export function planRepositories(input: {
  stored: StoredRepository[];
  /** The primary a project that has not been migrated still resolves from its legacy fields */
  legacyPrimary: string;
  primary?: string;
  additional?: unknown;
}): { repositories: StoredRepository[] } | { error: string } {
  const { stored } = input;
  const primary = input.primary !== undefined ? input.primary.trim() : stored[0]?.url?.trim() || input.legacyPrimary.trim();
  let extras: AdditionalRepository[];
  if (input.additional !== undefined) {
    if (!primary && Array.isArray(input.additional) && input.additional.length > 0) {
      return { error: "set the repository URL before adding more repositories" };
    }
    const parsed = parseAdditionalRepositories(input.additional, primary);
    if ("error" in parsed) return parsed;
    extras = parsed.value;
  } else {
    extras = stored.slice(1).map((r) => ({ url: r.url, name: r.name ?? "" }));
  }
  if (!primary) {
    if (extras.length > 0) return { error: "Remove the additional repositories before clearing the repository URL" };
    return { repositories: [] };
  }
  const checked = parseAdditionalRepositories(extras, primary);
  if ("error" in checked) return checked;
  return { repositories: withAdditionalRepositories(withPrimaryUrl(stored, primary), primary, checked.value) };
}

/**
 * What a write is guarded on: each entry as its id, address and name, in order. Compared as text rather
 * than as the stored documents, whose key order and missing optional fields differ between whatever wrote
 * them, so a guard on the documents themselves could refuse a save no one raced.
 */
export function repositoryFingerprint(list: ReadonlyArray<{ _id?: unknown; url?: string; name?: string }>): string[] {
  return list.map((r) => `${String(r._id)}|${r.url ?? ""}|${r.name ?? ""}`);
}

/** The same fingerprint, worked out by MongoDB over the stored array (4.4 has `$toString`) */
export const STORED_REPOSITORY_FINGERPRINT = {
  $map: {
    input: { $ifNull: ["$repositories", []] },
    as: "r",
    in: {
      $concat: [
        { $toString: "$$r._id" },
        "|",
        { $ifNull: ["$$r.url", ""] },
        "|",
        { $ifNull: ["$$r.name", ""] },
      ],
    },
  },
};
