# The board over MCP

Project key `BP`. Tools: `list_tasks`, `get_task`, `create_task`, `update_task`, `change_task_status`, `add_comment`, `list_comments`, `get_project`. They arrive on the claude.ai connector under a UUID prefix (`mcp__<uuid>__list_tasks`); a session-start reminder listing `board-planner` as needing authentication is about a stale local entry, not the connector. Call once before believing it.

## Columns

Statuses are the project's board columns; the ids below are the defaults this project uses.

| Column | Meaning |
|--------|---------|
| `planned` | backlog, not approved. Never taken. |
| `todo` | approved. Taken automatically. |
| `in_progress` | being worked. |
| `in_review` | code and tests complete, reviews running. |
| `needs_human_review` | a person has to decide. Comment why, then stop working on it. |
| `ready_to_test` | reviews clean, screen checked, PR open. |
| `done` | merged, documented, cleaned up. |

A task held by a running worker (`execution.runId` set) refuses to leave its column with a 409 naming the worker; do not force it from a machine session.

## Fields

- `Difficulty` (S, M, L, XL) is a project-defined field. In `get_task` it sits in `customFieldValues` keyed by the field's id; `get_project` maps ids to names. No value means S/M.
- Project-defined fields are written through `fields`, keyed by name: `fields: { "Difficulty": "M" }`. Tool schemas are strict; a parameter a tool does not declare is refused, not dropped.
- Assignees are usernames. On the BP board the user is `rafal`; `rpo` is refused as not a member, and `claude` hands the task to nobody.
- `agent` on `update_task` hands the task to a machine. A worker takes a task only when it is assigned to the machine's owner by that owner (or by the PM agent), names an agent, and the project is enabled for workers. Leave `agent` alone unless the request says a worker should run the task.

## Comments

One comment per stage, in English: the approach when starting, what changed and how it was verified when going to `in_review`, review rounds and what was fixed, the closing comment with PR links at `done`. A blocker is a comment plus `needs_human_review`, never silence.
