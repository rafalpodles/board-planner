# Git, GitHub, documentation

## Before the worktree

```bash
git ls-remote --heads origin | grep -i "<n>"
gh pr list --state all --search "BP-<n>"
```

Also `git worktree list`. A branch, PR or worktree named for the ticket means somebody is on it. Grep `list_tasks` titles for the same subject too; tickets get filed twice. For a ticket older than two weeks, grep the symbol its premise names and `git log --oneline --since=<date> --grep=<symptom> -i` before touching the file it names.

## Worktree

```bash
git fetch origin
git worktree add -b bp-<n>/<slug> ~/Documents/Projects/ClaudePlanner-worktrees/bp-<n> origin/main
cd ~/Documents/Projects/ClaudePlanner-worktrees/bp-<n> && npm ci && (cd mcp-server && npm ci)
git config --local user.name && git config --local user.email   # must both be set here, not inherited
```

The global git config is a work account and a fresh clone inherits it; the repo-local config is shared by every worktree of this checkout. If either prints nothing, the worktree is inheriting the global identity — set both locally before the first commit.

- Outside the repo. Never under the scratchpad or `.claude/worktrees`: a dev server there serves main's code.
- Never symlink `node_modules`, never borrow another worktree, never `git stash`.
- Commit after every part; worktrees have vanished mid-session. Artefacts go to the scratchpad. Read `git diff --stat` before every commit. No `git add -A`.
- `cd X && …`, never `cd X; …`. "No such file or directory" is a failed command even at exit 0.

## Identity

Every `gh` call runs as the repository owner. The active account flips between sessions, so check immediately before `pr create`, `pr merge` and the branch delete:

```bash
expected=$(gh repo view --json owner -q .owner.login)
[ "$(gh api user -q .login)" = "$expected" ] || gh auth switch --user "$expected"
```

`must be a collaborator` means the wrong account, not a permission problem.

## Before the PR

```bash
git rebase origin/main
git log --oneline 'HEAD@{1}..origin/main'
npx tsc --noEmit && npm test && rm -rf .next && npm run build
```

Re-run every e2e group the change touches after the rebase, not only your spec.

## The PR

```bash
gh pr create --base main --head bp-<n>/<slug> --title "<type>: <what> (BP-<n>)" --body-file <file>
```

Body: what changed and why, how it was verified (which tests, what was clicked, at which viewport), decisions taken. Conventional-commit type in the title: the squash makes the title the commit on `main` and the changelog line, and a breaking change needs `!` in it, since a `BREAKING CHANGE:` footer in a branch commit is dropped. No attribution footers.

Screenshot for a UI change. The repo is public, so a raw URL renders in the body:

```bash
SCRATCH=<scratchpad>/pr-assets
git fetch origin pr-assets 2>/dev/null \
  || git push origin "$(git commit-tree -m 'pr assets' "$(git hash-object -t tree /dev/null)")":refs/heads/pr-assets
git fetch origin pr-assets && git worktree add --detach "$SCRATCH" origin/pr-assets
mkdir -p "$SCRATCH/BP-<n>" && cp <shot>.png "$SCRATCH/BP-<n>/" \
  && git -C "$SCRATCH" add . && git -C "$SCRATCH" commit -qm "BP-<n>: screenshots" \
  && git -C "$SCRATCH" push -q origin HEAD:refs/heads/pr-assets && git worktree remove "$SCRATCH"
```

Then `![before/after](https://raw.githubusercontent.com/<owner>/<repo>/pr-assets/BP-<n>/<shot>.png)` in the body, with `<owner>/<repo>` from `gh repo view --json nameWithOwner -q .nameWithOwner`.

## Merge

Manual path. Preconditions: the last review round returned zero bugs, `gh pr checks <n> --watch` is all green, `gh pr view <n> --json baseRefName -q .baseRefName` prints `main`.

```bash
gh pr merge <n> --squash
gh pr view <n> --json state -q .state          # MERGED, before anything else
git push origin --delete bp-<n>/<slug>
git worktree remove ~/Documents/Projects/ClaudePlanner-worktrees/bp-<n>
git branch -D bp-<n>/<slug>
docker rm -fv bp<n>-mongo
```

Squash only: the repository allows no merge commits, and a squash takes the PR title as its subject with an empty body, so release-please reads each PR once. A merge commit put a PR in the changelog up to three times — its branch commits, the merge subject, and the title repeated in the merge body (BP-850). So the PR title is the changelog line: a conventional-commit title (`fix:`, `feat:`) naming what changed.

Separate calls, never chained. `gh pr merge` exits 0 without merging when the branch is behind, and deleting the head branch closes the PR; the result reads as CLOSED with the commit only in the worktree and `main` untouched. Recovery: re-push the branch, `gh pr reopen <n>` (or a new PR if reopen is refused), merge. A stacked PR keeps its dead base: `gh pr edit <n> --base main` first. Confirm on main afterwards: `git show origin/main:<path> | grep <symbol>`.

Auto path, where `main`'s ruleset requires "CI passed" (`gh api repos/<owner>/<repo>/rulesets`): preconditions are the zero-bug review and `baseRefName` printing `main` — a stacked PR's base requires no checks, so `--auto` would merge at once. `gh pr merge <n> --auto --squash` returns immediately; poll `gh pr view <n> --json state,mergeStateStatus` until `state` is MERGED, then clean up as above. Stop and report instead of waiting when "CI passed" goes red or `mergeStateStatus` is BEHIND (the ruleset is strict and auto-merge does not update the branch). A queued auto-merge takes later commits with it: any push after arming `--auto` needs its own review of the new head.

`git worktree remove` does not delete the branch itself, so `git branch -D` does. `-D`, not `-d`: a squash commit is not a descendant of the branch tip, so `-d` always refuses, and `merge-base --is-ancestor` is always false. What proves the merge is `state` reading MERGED, which is why the cleanup block reads it before deleting anything; `git fetch origin` and the `git show origin/main:<path>` check above confirm the content landed.

`docker rm -fv`, not `-f` alone: plain `-f` drops the container but leaves its anonymous volumes (`mongo:4.4` declares two, for `/data/db` and `/data/configdb`) sitting on disk with no name tying them back to `bp<n>`. They show up in `docker volume ls -f dangling=true` as bare hashes, indistinguishable from any other task's leftovers, and accumulate silently across sessions until something notices the disk filling up. `-v` removes them with the container in one step; recovering them after the fact means matching `docker volume inspect <id> --format '{{.CreatedAt}}'` against when that task's container was started, which is not a full guarantee.

`main` auto-deploys to production.

## Documentation

The two homes are defined in CLAUDE.md, section Documentation. In short:

- Product (what a user sees or does): the `board-planner-site` repo, `src/content/docs/docs/**`. A PR there, reviewed the same way, merged without asking. A new endpoint goes in `reference/rest-api.md`. Merging publishes.
- Technical (how to run, build and configuration, SMTP, an added service, a decision): Notion under `🗂️ Board Planner`. Search first; update the page that exists.
- A component the task touches that has no page yet gets one, whatever the size of the change.
