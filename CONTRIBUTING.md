# Contributing

Board Planner is open source under the [GNU AGPL v3](./LICENSE), with one exception: the
`src/ee/` directory is the commercial Enterprise Edition and carries [its own licence](./src/ee/LICENSE).

## What is accepted

- Pull requests to anything **outside `src/ee/`**: the board, the API, the MCP server, the
  worker, the menubar app, tests and documentation.
- Bug reports and feature requests as GitHub issues.

## What is not accepted

- Pull requests that add to or change files under `src/ee/`. They are closed without review, so
  that the copyright of the paid edition stays with a single holder and it can be licensed
  commercially. If you need something there, open an issue.

## Sign-off

Every commit must carry a Developer Certificate of Origin sign-off, which is your statement that
you have the right to submit the change under the AGPL. The text is in [`DCO`](./DCO). Signing
is one flag:

```bash
git commit -s -m "fix: what changed"
```

which appends `Signed-off-by: Your Name <you@example.com>` to the message. A workflow checks
both rules on every pull request from a fork and fails the pull request when a commit is unsigned
or a file under `src/ee/` changed.

## Before opening a pull request

```bash
npx tsc --noEmit
npm test
npm run build
```

A behaviour change comes with a unit test and, where a user can see it, a Playwright spec in
`e2e/`. Commit messages and pull request text are in English and follow conventional commits.
