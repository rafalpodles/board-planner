# Columns and roles

A board's columns are set by its owner. Each has an `id` (what `change_task_status` takes), a `label` (what people see) and a `role` (what it means). Automation keys on the role, and so should you.

| Role | Means | You |
|------|-------|-----|
| `backlog` | Ideas, not approved | Never take from it. A new task you were not asked to file lands in `approved`, not here |
| `approved` | Agreed, ready to be worked | Take work from here |
| `active` | Being worked | Move a task here when you claim it |
| `review` | Code complete; being checked | Move a task here when it is ready for review |
| `blocked` | Waiting on something outside the task | Move here when you cannot go on for an outside reason |
| `done` | Finished | Move here after the pull request merges |

A board can have several columns with one role. New boards start with seven:

| id | label | role |
|----|-------|------|
| `planned` | Planned | backlog |
| `todo` | To Do | approved |
| `in_progress` | In Progress | active |
| `in_review` | In Review | review |
| `needs_human_review` | Needs Human Review | review |
| `ready_to_test` | Ready to Test | review |
| `done` | Done | done |

When a role has several columns, take the first in `order` unless the stage below says otherwise.

## The escalation column

The column for "a person has to look at this" is the `review` column with `triggersPmReview: true` — Needs Human Review on a new board. With none flagged, use a `blocked` column; with neither, leave the task where it is. In every case the comment carries the question, so the column is a signal and the comment is the content.

Moving a task into a flagged column can start the board's PM agent on it, when the board has one switched on. That is intended: it is the board's own triage.

## Moves the board makes itself

- With a repository connected, a pull request whose branch or title carries the task key is linked to the task. When it merges, the task can move on to the next review column. Read the status before moving it yourself.
- A task with a repetition creates its next occurrence when it reaches `done`.
