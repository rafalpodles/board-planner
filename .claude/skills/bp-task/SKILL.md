---
name: bp-task
description: Use when picking up, implementing, reviewing, shipping or cleaning up after a Board Planner (BP) task in this repository, including when handed a task key like BP-561 or asked what to work on next.
---

# Working a BP task

A task is done when it is merged, documented, cleaned up after, and nobody was asked. Every stage below moves the task on the board. Skipping a stage is not finishing early; it is not finishing. Board comments, commits, PR text and docs are in English.

## 0. Pick

- A task named in the request wins. Otherwise pick from `todo`, never from `planned`: assigned to `rafal` first, then highest priority, then oldest.
- Before anything else: `git ls-remote --heads origin | grep -i <n>`, `gh pr list --state all --search BP-<n>`, and grep `list_tasks` titles for the same subject. Somebody may be on it, or it may already be fixed. Details in `references/git-github.md`.
- `change_task_status` to `in_progress`, `update_task` assignee `rafal`, `add_comment` with the approach. Every size starts at once; no plan waits for approval.
- Own worktree outside the repo, branch `bp-<n>/<slug>`, own Mongo container. Recipe in `references/git-github.md`.

## 1. Build

- Commit each part as it works.
- Something noticed on the way: if it belongs to the task, fix it now; if it is separate, `create_task` in `todo` with file:line, after grepping `list_tasks` titles for a duplicate.
- Tests: an e2e in `e2e/` listed in `e2e/groups.ts`, and a unit test. Both. Each new test goes red with the fix removed, for the stated reason: the red check in `references/e2e.md`.
- `npx tsc --noEmit`, `npm test`, `rm -rf .next && npm run build`; `npm test` inside `worker/` or `mcp-server/` when touched.
- `change_task_status` to `in_review`. Comment: what changed, how it was verified.

## 2. Review loop

- Independent agents, scaled to the diff (S/M: one reviewer): `references/review.md`. Fix every bug and send the delta to the same reviewers; repeat until a round finds zero bugs. Nits do not block and nit fixes get no re-review.
- A question only a person can answer: comment, `needs_human_review`, stop.

## 3. Look

- UI change: run the stack from the worktree, drive the flow at desktop and phone width, read the screenshot. Components in place, nothing overlapping, everything readable. Keep the screenshot for the PR.
- `change_task_status` to `ready_to_test`.

## 4. Ship

- Rebase on `origin/main`, rerun the touched e2e groups, `gh api user -q .login` prints `rafalpodles`, PR with what, why, how verified, and the screenshot for a UI change: `references/git-github.md`.
- Docs, when the task touches what a user sees or does: the product page in `board-planner-site`, its own PR, same review, merged. Technical matter (running, building, configuration) goes to Notion. A touched component with no page gets one.
- Green is: the last review round found no bugs, and CI passed. Green means merge, without asking. `gh pr merge <n> --merge`, read `state` until it says MERGED, only then delete the branch. Never both in one command. `main` deploys to production.

## 5. Clean up and close

- Stop the dev server and Playwright processes, `docker rm -f bp<n>-mongo`, delete the remote and local branch, `git worktree remove`, delete scratchpad files.
- Closing comment with the PR links, `change_task_status` to `done`.

## Red flags

| Thought | Reality |
|---------|---------|
| "The unit tests cover it" | The e2e ships too. |
| "The test passed first time" | Then it never went red. Do the red check. |
| "Four lines, one reviewer is enough" | One reviewer scaled to the diff is fine. Skipping is not. |
| "Reviewers only found nits" | Then the round found zero bugs and the loop ends. Nits are judged, not ignored. |
| "I'll ask before merging" | Green means merge. Ask only what you cannot decide. |
| "A branch in the main checkout is quicker" | Other sessions are in it. Worktree. |
| "No docs page exists, so nothing to update" | Write the page. |
| "New task goes to planned" | `todo`. `planned` is for someday. |
| "I'll clean up later" | Cleanup is stage 5, before `done`. |
