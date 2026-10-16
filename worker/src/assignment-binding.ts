import type { AssignedRepository, Assignment } from "./config.js";

/** One repository of a project, bound to a checkout on this machine. */
export interface BoundRepository {
  /** The project's own id for the entry; empty for an assignment that predates repositories. */
  id: string;
  /** What the operator recognises it by: its name, else the address the server named it by. */
  name: string;
  /** The remote this worker reported for it; it resolves back to the checkout and nothing else does. */
  remote: string;
  path: string;
  worktreeRoot: string;
}

export type BindOne = (
  path: string,
) => Promise<{ ok: true; path: string; worktreeRoot: string } | { ok: false; reason: string }>;

export type AssignmentBinding =
  | { ok: true; repositories: BoundRepository[] }
  | { ok: false; reason: string };

/** The repositories an assignment names: the list when the server sent one, else its single remote. */
export function repositoriesOf(assignment: Assignment): AssignedRepository[] {
  return assignment.repositories ?? [{ id: "", name: "", remote: assignment.remote }];
}

/**
 * Binds every repository of an assignment, and binds the project only when ALL of them bind: a run
 * in some of a project's repositories would hand the agent a change it cannot make whole. The first
 * failure names the repository, with the sentence the single-repository path already used leading it
 * (`describeBindingError` in the app matches on "no checkout of").
 *
 * The server sends a remote, never a path; resolving it here against this machine's own inventory is
 * what keeps "where anything runs" a local decision. One checkout serves at most one repository: two
 * entries that resolve to the same directory would run two worktrees in one repository, so the second
 * is refused rather than bound twice.
 */
export async function bindAssignment(
  assignment: Assignment,
  inventory: readonly { remote: string; path: string }[],
  bindOne: BindOne,
): Promise<AssignmentBinding> {
  const wanted = repositoriesOf(assignment);
  const several = wanted.length > 1;
  const bound: BoundRepository[] = [];

  for (const repository of wanted) {
    const label = several ? ` (repository ${repository.name || repository.remote})` : "";
    const local = inventory.find((r) => r.remote === repository.remote);
    if (!local) {
      return { ok: false, reason: `no checkout of ${repository.remote} on this machine${label}` };
    }
    const result = await bindOne(local.path);
    if (!result.ok) return { ok: false, reason: `${result.reason}${label}` };

    const twin = bound.find((b) => b.path === result.path);
    if (twin) {
      return {
        ok: false,
        reason: `${repository.name || repository.remote} and ${twin.name || twin.remote} are the same checkout on this machine, and a checkout serves one repository${label}`,
      };
    }
    bound.push({
      id: repository.id,
      name: repository.name || repository.remote,
      remote: repository.remote,
      path: result.path,
      worktreeRoot: result.worktreeRoot,
    });
  }
  return { ok: true, repositories: bound };
}
