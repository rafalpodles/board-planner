export interface AssignmentDraft {
  project: string;
  proposedPath: string;
}

export type AssignmentProblem =
  | { kind: "no-project" }
  | { kind: "no-path" }
  | { kind: "relative-path"; path: string }
  | { kind: "duplicate"; path: string };

// The server refuses the same pair twice and a worker can only bind one checkout per project, so
// both are caught here rather than after a round trip.
export function assignmentProblem(
  drafts: AssignmentDraft[],
  candidate: AssignmentDraft
): AssignmentProblem | null {
  const path = candidate.proposedPath.trim();
  if (!candidate.project) return { kind: "no-project" };
  if (!path) return { kind: "no-path" };
  // repos.ts refuses anything not absolute, so a relative path is a binding that silently never
  // happens — the worker would just report it as unbound on its next heartbeat.
  if (!path.startsWith("/")) return { kind: "relative-path", path };
  if (drafts.some((d) => d.project === candidate.project)) return { kind: "duplicate", path };
  return null;
}

export function describeProblem(problem: AssignmentProblem): string {
  switch (problem.kind) {
    case "no-project":
      return "Pick a project";
    case "no-path":
      return "Enter the repository path on the worker's own machine";
    case "relative-path":
      return `${problem.path} must be an absolute path — the worker refuses anything else`;
    case "duplicate":
      return "This worker already has an assignment for that project";
  }
}

export function withAssignment(
  drafts: AssignmentDraft[],
  candidate: AssignmentDraft
): AssignmentDraft[] {
  return [...drafts, { project: candidate.project, proposedPath: candidate.proposedPath.trim() }];
}

export function withoutAssignment(drafts: AssignmentDraft[], project: string): AssignmentDraft[] {
  return drafts.filter((d) => d.project !== project);
}

export function hasChanged(original: AssignmentDraft[], drafts: AssignmentDraft[]): boolean {
  const key = (list: AssignmentDraft[]) =>
    list
      .map((d) => `${d.project} ${d.proposedPath}`)
      .sort()
      .join("\n");
  return key(original) !== key(drafts);
}
