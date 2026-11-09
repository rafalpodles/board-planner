# board-planner

A Claude Code plugin with one skill that teaches an agent to work tasks from a
[Board Planner](https://board-planner.com) board over its MCP server.

Connecting the MCP server gives an agent the tools. This skill gives it the habits, so the board
shows what every agent is doing without anyone asking:

- **Read** the board first and choose columns by their role, never by a guessed id.
- **Pick** the task the request names, or the next one from an approved column — never from the
  backlog, and never one whose blocker is not done.
- **Claim** it before writing code: active column, assigned to the connection's own account, a
  comment with the approach.
- **Work** with the task key in the branch name and the pull request title, ticking acceptance
  criteria as they are met.
- **File** anything separate found along the way as a new backlog task, after looking for a
  duplicate.
- **Escalate** a decision only a person can make: a comment with the question and a
  recommendation, the task in the review column, and stop.
- **Close** the task after its pull request merges, with the links.

## Install

Connect the MCP server first. It is part of every Board Planner instance at `/api/mcp` — in the
cloud, `https://<your-organisation>.board-planner.com/api/mcp`. Clients that support OAuth sign in
with no client id or secret; others use an API token from Settings → API Tokens. See
[MCP integration](https://board-planner.com/docs/ai/claude-code-and-mcp/).

Then install the plugin:

```
/plugin marketplace add rafalpodles/board-planner
/plugin install board-planner@board-planner
```

The skill loads when the agent is asked to work on the board: "take the next task", "work on
ABC-12", "what should I do next".

## More

- [Agent skill](https://board-planner.com/docs/ai/agent-skill/) — what each stage writes to the
  board, and how to make the skill your own.
- Project instructions (CLAUDE.md, AGENTS.md) that name a board, a process or a column win over
  the skill.

Licensed AGPL-3.0-only, like the rest of the repository.
