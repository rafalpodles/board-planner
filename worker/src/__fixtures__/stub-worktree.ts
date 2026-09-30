import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// What `git worktree add` leaves for a stubbed git: the directory, and the `.git` file the pin is
// recorded from and checked against (BP-794)
export function stubWorktree(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), `gitdir: ${path}.git-dir\n`);
}
