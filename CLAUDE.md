# ClaudePlanner

## ClaudePlanner integration
claudeplanner_project_key: CP

### Workflow
- On session start: run `list_tasks` for this project to see current work.
- When asked "what to work on" / "co robić" — list tasks and suggest next one.
- Log important decisions, blockers, or completion notes with `add_comment`.
- When user describes new work, ask if it should be tracked and `create_task` if yes.

### Task statuses
- `planned` — idea/backlog, NOT approved for work. Claude never touches these.
- `todo` — approved for work. Claude picks these up automatically.
- `in_progress` — actively being worked on.
- `in_review` — code complete, awaiting code review.
- `ready_to_test` — review passed, ready for final verification and merge.
- `done` — merged to `main`, task complete.

### Autonomous task processing
Claude automatically picks up tasks in `todo` status (assigned to `claude` or unassigned) and processes them through the pipeline. No user confirmation needed for `todo` tasks.

#### Size-based approach
- **S/M tasks** — Claude implements immediately, no upfront plan needed.
- **L/XL tasks** — Claude first writes a plan as a task comment and **waits for user approval** before writing any code.

#### Pipeline: todo → in_progress → in_review → ready_to_test → done

**1. todo → in_progress (Start work)**
- Pick the task, assign to `claude`, change status to `in_progress`.
- Add a comment: what approach will be taken (for S/M: brief, for L/XL: detailed plan — wait for approval).
- Create a feature branch from `main`: `cp-<number>/<short-slug>` (e.g. `cp-5/remove-in-testing`).
- Implement the task on that branch.

**2. in_progress → in_review (Implementation done)**
- Run `npm run build` to verify the build passes.
- Commit changes to the feature branch (conventional commits).
- Add a comment: summary of what was done, any decisions made.
- Change status to `in_review`.

**3. in_review → ready_to_test (Code review)**
- Review the diff between the feature branch and `main`.
- Check for: correctness, security, code style, missing edge cases.
- If issues found: fix them on the branch, re-commit, add comment with findings. Stay in `in_review`.
- If review passes: add comment confirming review OK. Change status to `ready_to_test`.
- Create a GitHub PR (`gh pr create`) for visibility and history.

**4. ready_to_test → done (Final check & merge)**
- Verify the branch is clean and build passes.
- Merge the PR into `main`.
- Delete the feature branch.
- Add a closing comment on the task.
- Change status to `done`.

#### Blocker handling
- If Claude gets stuck (missing info, external dependency, unclear requirements): stay in `in_progress`, add a comment describing the blocker, and **stop working on the task**.
- Do not brute-force or guess. Wait for user input.

### Conventions
- Task keys: `CP-1`, `CP-2` — use these when referencing tasks.
- Assignees use **usernames** (not IDs). `claude` = Claude Code, `rpo` = you.
- Branch naming: `cp-<number>/<short-slug>` (e.g. `cp-3/dropdown-menu`)

## Tech stack
- Next.js 16 (App Router) + TypeScript
- MongoDB (Railway) + Mongoose ODM
- Tailwind CSS 4
- Basic Auth
- MCP Server (separate package in `mcp-server/`)

## Build
```bash
npm run build        # Next.js app
cd mcp-server && npm run build  # MCP server
```

## Deploy
Railway auto-deploys from `main` branch.
App: https://claude-planner-production.up.railway.app
