import { echo } from "@/lib/echo";

// One sentence for a name nobody holds, an account with no access and a deactivated one, on every
// surface: telling them apart says "@x exists" to anyone who can reach any board (BP-513).
export function noBoardAccess(name: string): string {
  return `@${echo(name.trim().toLowerCase())} has no access to this board`;
}

export function noAccessToAssign(name: string): string {
  return `${noBoardAccess(name)}, so the task cannot be assigned to them. Check the username; a board owner can add people in the project's Members settings.`;
}
