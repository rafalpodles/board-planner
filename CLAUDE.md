# ClaudePlanner

## ClaudePlanner integration
claudeplanner_project_key: CP

### Workflow
- On session start: run `list_tasks` for this project to see current work.
- When asked "what to work on" / "co robić" — list tasks and suggest next one.
- When starting a task: `change_task_status` → `in_progress`.
- When finishing a task: `change_task_status` → `done` (or `in_review` / `ready_to_test`).
- Log important decisions, blockers, or completion notes with `add_comment`.
- When user describes new work, ask if it should be tracked and `create_task` if yes.

### Conventions
- Task keys: `CP-1`, `CP-2` — use these when referencing tasks.
- Assignees use **usernames** (not IDs). `claude` = Claude Code, `rpo` = you.
- Statuses: planned → todo → in_progress → in_review → ready_to_test → in_testing → done

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
