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
git config user.name && git config user.email   # Rafał Podleś, rafalpodles@gmail.com
```

The global git config is the work account and a fresh clone inherits it; the repo-local config is shared by every worktree of this checkout. If the check above prints anything else: `git config user.name "Rafał Podleś" && git config user.email rafalpodles@gmail.com`.

- Outside the repo. Never under the scratchpad or `.claude/worktrees`: a dev server there serves main's code.
- Never symlink `node_modules`, never borrow another worktree, never `git stash`.
- Commit after every part; worktrees have vanished mid-session. Artefacts go to the scratchpad. Read `git diff --stat` before every commit. No `git add -A`.
- `cd X && …`, never `cd X; …`. "No such file or directory" is a failed command even at exit 0.

## Identity

Every `gh` call runs as `rafalpodles`. The active account flips between sessions, so check immediately before `pr create`, `pr merge` and the branch delete:

```bash
gh api user -q .login   # rafalpodles, else: gh auth switch --user rafalpodles
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

Body: what changed and why, how it was verified (which tests, what was clicked, at which viewport), decisions taken. Conventional-commit type in the title. No attribution footers.

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

Then `![before/after](https://raw.githubusercontent.com/rafalpodles/board-planner/pr-assets/BP-<n>/<shot>.png)` in the body.

## Merge

Preconditions: the last review round returned zero bugs, `gh pr checks <n> --watch` is all green, `gh pr view <n> --json baseRefName -q .baseRefName` prints `main`.

```bash
gh pr merge <n> --merge --subject "<PR title> (#<n>)"
gh pr view <n> --json state -q .state          # MERGED, before anything else
git push origin --delete bp-<n>/<slug>
git worktree remove ~/Documents/Projects/ClaudePlanner-worktrees/bp-<n>
docker rm -f bp<n>-mongo
```

Separate calls, never chained. `gh pr merge` exits 0 without merging when the branch is behind, and deleting the head branch closes the PR; the result reads as CLOSED with the commit only in the worktree and `main` untouched. Recovery: re-push the branch, `gh pr reopen <n>` (or a new PR if reopen is refused), merge. A stacked PR keeps its dead base: `gh pr edit <n> --base main` first. Confirm on main afterwards: `git show origin/main:<path> | grep <symbol>`.

`main` auto-deploys to production.

## Documentation

The two homes are defined in CLAUDE.md, section Documentation. In short:

- Product (what a user sees or does): the `board-planner-site` repo, `src/content/docs/docs/**`. A PR there, reviewed the same way, merged without asking. A new endpoint goes in `reference/rest-api.md`. Merging publishes.
- Technical (how to run, build and configuration, SMTP, an added service, a decision): Notion under `🗂️ Board Planner`. Search first; update the page that exists.
- A component the task touches that has no page yet gets one, whatever the size of the change.
