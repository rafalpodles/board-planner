import { lstatSync, rmSync, unlinkSync } from "fs";
import { join } from "path";

export interface Removal {
  removed: string[];
  refused: string[];
}

function refusal(path: string): string | null {
  if (path.startsWith("/")) return "an absolute path";
  const segments = path.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "not a plain relative path";
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return "inside a .git";
  return null;
}

function removeOne(root: string, path: string): string | null {
  const why = refusal(path);
  if (why) return why;
  const segments = path.replace(/\/$/, "").split("/");
  let at = root;
  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    at = join(at, segments[depth]);
    const parent = lstatSync(at, { throwIfNoEntry: false });
    if (!parent) return null;
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      return `${segments.slice(0, depth + 1).join("/")} is not a directory of the worktree's own`;
    }
  }
  const target = join(at, segments[segments.length - 1]);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return null;
  // rm does not follow a symlink it meets inside the tree; unlink removes a symlink itself
  if (stat.isDirectory()) rmSync(target, { recursive: true, force: true });
  else unlinkSync(target);
  return null;
}

// Only paths git listed in the worktree, each resolved under its root through real directories
export function removeFromWorktree(root: string, paths: string[]): Removal {
  const removal: Removal = { removed: [], refused: [] };
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { removed: [], refused: paths.map((path) => `${path} (the worktree is not a directory)`) };
  }
  for (const path of paths) {
    try {
      const why = removeOne(root, path);
      if (why) removal.refused.push(`${path} (${why})`);
      else removal.removed.push(path);
    } catch (error) {
      removal.refused.push(`${path} (${String(error)})`);
    }
  }
  return removal;
}
