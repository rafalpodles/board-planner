# Columns and roles

A board's columns are set by its owner. Each has an `id` (what `change_task_status` takes), a `label` (what people see) and a `role` (what it means). Automation keys on the role, and so should you.

| Role | Means | You |
|------|-------|-----|
| `backlog` | Proposed, not yet approved | Never take from it. A task you file lands here, unless you were asked otherwise |
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

The column for "a person has to look at this" is the `review` column with `triggersPmReview: true` — Needs Human Review on a new board. With none flagged it is the first `review` column, as it is for the board's own workers; with no `review` column at all, leave the task where it is. The comment carries the question: the column is the signal, the comment is the content.

A `blocked` column is for waiting on something outside the task, such as another team or a vendor, not for a question to a person.

Moving a task into a flagged column can start the board's PM agent on it, when the board has one switched on. That is intended: it is the board's own triage.

## Moves the board makes itself

- With a GitHub or GitLab repository connected, a pull request whose branch or title carries the task key is linked to the task. On GitHub the task also shows its CI.
- On a board that still has the default `in_review` and `ready_to_test` columns and a GitHub repository, a sync run by a person or a connection (`sync_repository`) moves a task from `in_review` to `ready_to_test` once its pull request has merged. The sync never moves a task to `done`. Read the status before moving a task yourself.
- A task with a repetition creates its next occurrence when it reaches `done`.
