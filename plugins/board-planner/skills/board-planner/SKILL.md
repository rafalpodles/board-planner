---
name: board-planner
description: Use when working tasks from a Board Planner board over its MCP server — picking the next task, starting one by its key (e.g. ABC-12), reporting progress, filing what you find along the way, handing a question to a person, or closing a task after its pull request merges.
---

# Working a Board Planner task

The board is the queue and the record. A person reading it should know, without asking you, what is being worked, by whom, how, and what is left. Every stage below writes to the board; work the board does not show did not happen as far as the team can tell.

The tools are the Board Planner MCP server's (`list_tasks`, `get_task`, `get_project`, `change_task_status`, …). Your client may prefix their names; the names below are the server's own.

## 0. Read the board first

- `get_project` with the project key. Its `columns` are this board's own: ids, labels and a **role** each — `backlog`, `approved`, `active`, `review`, `blocked`, `done`. Choose columns by role, then use the column's `id` in calls. Never assume `todo` or `in_progress` exist. `references/columns.md` maps each stage to a role.
- Its `customFields` are the board's own fields. Write them through `fields`, keyed by name: `{"Difficulty": "M"}`.
- `whoami` gives the username this connection acts as. That is who you assign work to when you take it.
- Project instructions (CLAUDE.md, AGENTS.md) may name a board, a process or a column to use. They win over this skill.

## 1. Pick

- A task named in the request wins.
- Otherwise take from an `approved` column, never a `backlog` one: backlog is unapproved ideas. Order: assigned to you, then highest priority, then oldest. `list_tasks` with `status` set to the approved column ids.
- Read the task and its comments (`get_task`, `list_comments`) before starting: decisions are often left there. Skip it when it is assigned to somebody else, already has an open pull request, or is blocked by a task that is not yet in a `done` column. A `blocked_by` link stays after its blocker is finished, so read the blocker's status rather than filtering on the link.

## 2. Claim before you code

Three writes, before the first line of code:

1. `change_task_status` to the board's `active` column.
2. `update_task` with `assignee` set to the `whoami` username.
3. `add_comment` with the approach in a few sentences.

A task another person or agent is visibly working is theirs. Claiming late is how two agents end up fixing the same thing.

## 3. Work

- Put the task key in the branch name and in the pull request title (`abc-12/short-slug`, `fix: … (ABC-12)`). A board with a connected repository links the pull request to the task from the key alone and shows its CI.
- Tick acceptance criteria as they are met: `set_checklist_item` by id or exact text. Do not resend the whole list to tick one item.
- Something found along the way that is **part of this task**: do it now. Something **separate**: search first (`list_tasks` with `search`, or `search_tasks`), then `create_task` with what you saw and where (file and line). Leave out `status`: it lands in the backlog, and a person approves it onward. Do not widen the current change to fix it.

## 4. Hand over to review

- Code complete and checked: `change_task_status` to the first `review` column.
- `add_comment`: what changed, how it was verified, and the pull request link.

## 5. When only a person can decide

A product question, a missing credential, two valid designs with a real trade-off: do not guess.

- `add_comment` with the question, the options and your recommendation.
- Move the task to the escalation column (`references/columns.md`) and stop working on it.

## 6. Close

- After the pull request merges: a closing comment with the pull request links, then `change_task_status` to the `done` column.

## Rules the server enforces

- A task a worker machine is running refuses to leave its column (an error naming the worker). Do not try to force it; say so and leave it.
- Every tool refuses an argument it does not declare. A `status` on `update_task` belongs to `change_task_status`, a `checklist` is `acceptanceCriteria`, and a project-defined field goes inside `fields`.
- `update_task`'s `agent` hands a task to a machine. Leave it alone unless the request says a worker should run the task.

More on columns, fields and batches: `references/columns.md`, `references/tools.md`.

## Red flags

| Thought | Reality |
|---------|---------|
| "I'll move it to In Progress once it works" | Claim first. The board is how others know it is taken. |
| "The column is probably called `todo`" | Read `get_project`. Columns are the board's own. |
| "This backlog item looks easy, I'll take it" | Backlog is unapproved. Take from `approved`. |
| "I found it, so I'll file it as approved" | Filed work goes to the backlog. A person approves it. |
| "I'll fix that unrelated bug while I'm here" | File it as a task. Keep the change about its task. |
| "I'll pick the design and mention it in the PR" | A decision only a person can make is a comment and the escalation column. |
| "The PR is linked, the task can stay where it is" | Close it: comment with links, move to done. |
