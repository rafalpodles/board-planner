# Tests in this repo

## Unit

- `npm test` is vitest. It does not reach `worker/` or `mcp-server/`; run `npm test` inside each one the change touches.
- `npx tsc --noEmit` is the only local check that type-checks test files. CI runs it. Run it before every push.
- `npm run lint` lints nothing. Do not report it as a check.
- A component with a sibling `*.test.tsx` gets a unit test in the same pattern, next to the e2e.
- After adding a `next/navigation` call to a shared hook: `grep -rln 'vi.mock("next/navigation"' src | xargs grep -L <hook>` lists the specs whose mock must grow.
- A fresh worktree needs `npm ci && (cd mcp-server && npm ci)`, or five tests fail with `Cannot find module '../../../mcp-server/node_modules/zod'`.

## End-to-end (Playwright, `e2e/`)

Every spec must be listed in `e2e/groups.ts`. A spec in no group runs nowhere, and `groups.test.ts` fails.

Own Mongo and own ports per task. Sibling sessions run suites at the same time, and `seed()` wipes the whole database it points at:

```bash
N=560
docker run -d --name bp$N-mongo -p 27$N:27017 mongo:4.4
E2E_MONGODB_URI=mongodb://localhost:27$N/bp${N}_e2e E2E_PORT=$((30000 + N * 10)) npx playwright test e2e/<name>.spec.ts
```

The database name must end in `_e2e`. A run owns `E2E_PORT` through `E2E_PORT+5`. `docker rm -f bp$N-mongo` once the task is done.

- Before believing a failure: `ps aux | grep -E "[p]laywright|[n]ext dev"` (a sibling suite), `docker ps` (the container), `df -h /System/Volumes/Data` (a full disk kills Mongo mid-suite and reads as two product bugs).
- After any `next dev` in the worktree, `rm -rf .next` before `npm run build`, or the build fails on stale generated types.
- New fixture ids and task numbers: check what `git show origin/main:e2e/seed.ts` already uses, not your local base.

## Assertions that pass for the wrong reason

- Lists render optimistically. When the server effect is the subject, arm `page.waitForResponse` before the click and await it. Never synchronise on rendered text.
- The board polls every 10 s. After the response, assert with `{ timeout: 1_000 }`, or the poll satisfies a removal assertion even with the fix deleted.
- "X did not happen" right after a trigger: the pre-trigger state already satisfies it. Settle about 1000 ms first, or wait on a signal only the divergence can fire.
- `expect(promise).resolves` reads the DOM once. Put a retrying assertion before it, or use `expect.poll`.
- Before `toHaveCount(0)` or `toBeHidden` on a fetched screen, one positive assertion only a loaded page can satisfy.
- Assert the shape in the slot (`/^TP-\d+$/`), not the one value you expected.
- A `fill()` before hydration is dropped, and `toHaveValue` cannot tell. Poll on something derived from React state.
- A save button relabels itself to "Saving…". Waiting for the old label to vanish returns at click time.
- Two saves share one toast. Sync on the responses; read the toast with `.last()`.
- `test.fail()` turns any failure into a pass.
- When the test types the expected text into the app, scope the locator to the surface only the product writes.
- Notification writes are fire-and-forget: `toPass` retries, not one load.
- Drag: dnd-kit in the list and sidebar, native HTML5 elsewhere. `page.mouse` drives both; synthetic events prove nothing.
- Menu and drag take different paths (`changeStatus` vs `updateTask`). Test the gesture the ticket names.

## The control

Next to the case the fix must refuse, assert the case that is supposed to work. Otherwise a silence caused by a mis-wired fixture reads exactly like a silence caused by the fix. Skip the e2e only for work with no user-reachable surface at all (a build script, a type-only change, a refactor with no behavioural delta). "The unit tests cover it" is not a reason, and neither is "the flow is fiddly to drive"; the friction is where the bugs are.

## The red check

1. Commit the fix first.
2. Restore the pre-fix file from the branch base: `git show $(git merge-base origin/main HEAD):<path> > <path>`. Never bare `HEAD` (that is your commit now), never `git stash` (one stash list for every worktree).
3. Run the spec. Read the failure reason, not the exit code. Green means the test is decoration.
4. Put the fix back: `git checkout HEAD -- <path>`, then `git status` must be clean.
5. A fix with several parts: revert each part alone, then all together.

## Looking at the screen

Green tests are not a look. Run the stack, drive the flow, read a screenshot.

- Local stack from the task worktree: `.env.local` (gitignored) with `MONGODB_URI=mongodb://localhost:27$N/bp$N` and `NEXT_PUBLIC_APP_URL=http://localhost:<port>`, then `PORT=<port> npm run dev`. Seed an admin into `users` (bcryptjs, cost 10, `role: "admin"`) and log in at `/login`.
- Confirm the browser runs your build first: pick an unconditional marker from the diff and assert it in the DOM.
- Check the phone viewport when the component has a `sm:`, `md:` or `lg:` variant. Measure against a known-good sibling, never against a label.
- Browser pane limits: `form_input` does not fire React's onChange (native value setter plus a dispatched `input` event does); `computer{key}` may deliver nothing (dispatch a `KeyboardEvent`); coordinate clicks miss after `resize_window`. Say in the task comment which paths were driven for real and which were synthesised.
