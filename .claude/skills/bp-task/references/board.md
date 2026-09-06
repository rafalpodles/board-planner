# The board over MCP

Project key `BP`. Tools: `list_tasks`, `get_task`, `create_task`, `update_task`, `change_task_status`, `add_comment`, `list_comments`, `get_project`. They arrive on the claude.ai connector under a UUID prefix (`mcp__<uuid>__list_tasks`); a session-start reminder listing `board-planner` as needing authentication is about a stale local entry, not the connector. Call once before believing it.

## Columns

Statuses are project-defined board columns mapped to semantic roles (`backlog`, `approved`, `active`, `review`, `blocked`, `done`); automation keys on the role, not the display name. The ids below are the defaults this project uses.

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
- Assignees are usernames. On the BP board the user is `owner`; `owner` is refused as not a member, and `claude` hands the task to nobody.
- `agent` on `update_task` hands the task to a machine, by name. Leave it alone unless the request says a worker should run the task.

## Handing a task to a worker

A machine belongs to whoever enrolled it and takes a task only when all of these hold: the task is assigned to that person and `assignedBy` is that same person or the PM agent (work another person hands you is a proposal, nothing runs it unattended); the task names an agent; the project is enabled for workers and the owner can reach it. A task assigned before `assignedBy` existed is never claimed; assign it again to record one. Assigning to `claude` hands the task to nobody: it is a person-shaped account. A project or global agent may be chosen by anyone who can edit the task; a personal agent only by its owner onto their own task, and it is dropped when the task is handed on. An agent with no steps is refused. A task naming no agent is never claimed; there is no fallback to the project default, which only pre-selects the picker.

## Comments

One comment per stage, in English: the approach when starting, what changed and how it was verified when going to `in_review`, review rounds and what was fixed, the closing comment with PR links at `done`. A blocker is a comment plus `needs_human_review`, never silence.
