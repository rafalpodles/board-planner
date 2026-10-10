# Tools worth knowing

The full list is at https://board-planner.com/docs/ai/claude-code-and-mcp/.

## Reading

- `list_tasks` answers a page at a time (50 by default, 100 at most). Follow `nextOffset` until it is `null`; a list that stops short is not the whole board. Filters include `status` (comma-separated ids), `assignee`, `priority`, `category`, `search`, `sprint`, `parent`, `hasChildren`, `fields`, `dueBefore`, `dueAfter`, `updatedSince` and `archived`. `blocked: true` means the task has a `blocked_by` link, finished blocker or not.
- `get_task` reads one task in full: description, acceptance criteria with their ids, links, and an epic's children with its progress.
- `search_tasks` searches every board the connection can reach, by key or text.
- `my_tasks` lists the connection's own open tasks across boards.
- `get_task_activity` reads a task's history.

## Writing

- `create_task` takes `status` as a column id. Left out, the task lands in the board's default column: its first `backlog` column, or on a board with none, its first `approved` one. Name another column only when you were asked to.
- `acceptanceCriteria` is markdown lines (`- [ ] …`); it becomes a checklist. Tick one item with `set_checklist_item`.
- `minimal: true` on `create_task`, `update_task` and `change_task_status` answers with the key, title, status, priority, assignee and a link instead of the whole stored task.
- `create_tasks` and `update_tasks` take up to 30 items in one call. In `create_tasks` an item can name its `parent` or `blockedBy` as `#3`, an earlier item of the same call. A batch is not atomic: read the answer per item.
- `link_tasks`: `parent_of`, `blocked_by`, `relates`, `duplicates`, read from the first task's side.

## Assigning

- `list_members` names who the board can assign to. An assignee who is not a member is refused.
- `whoami` is the connection's own username.
