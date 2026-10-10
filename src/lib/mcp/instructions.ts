export const SERVER_INSTRUCTIONS = `Board Planner is a task board; these tools read and write it as the connected account.

- Columns are each board's own. Read get_project and choose a column by its role (backlog, approved, active, review, blocked, done), then use its id. Never assume an id such as "todo".
- Take work from an approved column, never a backlog one. A task you file goes to an approved column.
- Before working a task: change_task_status to an active column, update_task with assignee set to whoami's username, and add_comment with the approach.
- Something separate found along the way: search for a duplicate (list_tasks with search), then create_task with what you saw and where.
- When only a person can decide: add_comment with the question and your recommendation, move the task to the review column whose triggersPmReview is true (else a blocked column), and stop.
- Put the task key (e.g. ABC-12) in the branch name and pull request title; the board links them from it.
- When the work is ready for review, move the task to a review column and comment what changed and how it was verified. After the pull request merges, comment the links and move it to the done column.
- Project-defined fields go through fields, keyed by name. A task a worker machine is running refuses to leave its column; do not try to force it.

The full workflow is the board-planner agent skill: https://board-planner.com/docs/ai/agent-skill/`;
