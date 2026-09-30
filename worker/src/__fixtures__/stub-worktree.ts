import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { basename, join } from "path";

// What `git worktree add` leaves for a stubbed git whose `rev-parse` answers `commonDir`: the
// directory, its `.git` file, and the admin dir in the clone the pin is derived from (BP-794)
export function stubWorktree(path: string, commonDir: string): void {
  mkdirSync(path, { recursive: true });
  mkdirSync(commonDir, { recursive: true });
  const admin = join(realpathSync(commonDir), "worktrees", basename(path));
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "gitdir"), `${join(realpathSync(path), ".git")}\n`);
  writeFileSync(join(admin, "commondir"), "../..\n");
  writeFileSync(join(path, ".git"), `gitdir: ${admin}\n`);
}
