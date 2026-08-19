# A machine takes its owner's work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker stops racing every other machine for one nominated user's tasks and takes only the work its own owner handed it, where handing it over means choosing an agent.

**Architecture:** Two new reference fields — `Worker.owner` and `Task.assignedBy` — replace the project-wide `claimAssignee` nominee as the thing the claim filter keys on. Choosing an agent becomes the hand-over gesture, so a task with no agent is a task a person does. Everything here is server and web; the consent surface for work somebody *else* assigns you (menubar approval) is a second plan and deliberately absent, so until it exists a task assigned by anyone but the owner simply does not run.

**Tech Stack:** Next.js 16 App Router, TypeScript, Mongoose 9 on MongoDB 4.4, vitest, React 19, Tailwind 4.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-08-17-machine-belongs-to-a-person-design.md`. Read it before starting.
- MongoDB 4.4: aggregations must avoid `$dateTrunc`, `$dateAdd`/`$dateDiff`, `$setWindowFields`, and `$lookup` mixing `localField`/`foreignField` with an inline `pipeline`.
- Mongoose 9 refuses an aggregation-pipeline update passed as a bare array; pass `{ updatePipeline: true }`.
- A pipeline update turns off schema casting — cast ObjectIds in JS before they reach one.
- Tests run with `./node_modules/.bin/vitest` and typecheck with `./node_modules/.bin/tsc --noEmit`. `npx tsc` is shimmed in this environment and does not typecheck.
- `npm run build` and `npm test` both skip type errors in test files. Run `./node_modules/.bin/tsc --noEmit` before every commit.
- Comments: only where the reason is not evident from the code. No javadoc, no narration.
- Commit messages in English, conventional commits, no attribution trailers.
- Every task ends green: `./node_modules/.bin/vitest run` and `./node_modules/.bin/tsc --noEmit`.

## File Structure

| File | Responsibility |
|---|---|
| `src/models/worker.ts` | gains `owner`, the user this machine belongs to |
| `src/models/task.ts` | gains `assignedBy`, who set the current assignee |
| `src/lib/worker-service.ts` | `registerWorker` records the owner; `verdictFor` refuses an ownerless machine |
| `src/app/api/workers/enrolment/device/[userCode]/approve/route.ts` | passes the approving user's id as the owner |
| `src/lib/task-service.ts` | writes `assignedBy`; the claim filter keys on owner + agent |
| `src/lib/agent-snapshot.ts` | the fallback chain goes; no agent means no snapshot |
| `src/models/project.ts`, `src/types/index.ts` | `claimAssignee` and `claimScope` removed |
| `src/app/(app)/projects/[projectId]/settings/sections/WorkersSection.tsx` | the two removed settings go with them |
| `src/components/tasks/detail/PropertyRail.tsx` | the empty option says nobody will take it |

---

### Task 1: A machine belongs to a person

**Files:**
- Modify: `src/models/worker.ts:24` (beside `approvedProjects`)
- Modify: `src/lib/worker-service.ts:206-231` (`registerWorker`)
- Modify: `src/lib/worker-service.ts` (`verdictFor`, after the `approvedProjects` check)
- Modify: `src/app/api/workers/enrolment/device/[userCode]/approve/route.ts:99-105`
- Test: `src/lib/worker-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Worker.owner?: Types.ObjectId | null`. `registerWorker` gains `ownerId?: string`. `verdictFor` refuses `{ ok: false, reason: "this machine has no owner" }` when `owner` is absent.

- [ ] **Step 1: Write the failing tests**

In `src/lib/worker-service.test.ts`, beside the existing `verdictFor` tests:

```ts
// The enrolment screen says "The machine acts under this account". Until BP-358 that was a display
// name; a machine enrolled before it has no owner, and there is no safe guess — a fallback to the
// old project-wide nominee would keep the race it replaces alive indefinitely.
it("refuses a machine with no owner", () => {
  const verdict = verdictFor(
    worker({ owner: null }),
    project(),
    PROTOCOL_VERSION,
    new Date(),
    []
  );

  expect(verdict).toMatchObject({ ok: false });
  expect(verdict.reason).toMatch(/owner/i);
});

it("lets a machine with an owner through", () => {
  expect(verdictFor(worker(), project(), PROTOCOL_VERSION, new Date(), []).ok).toBe(true);
});
```

Give the file's existing `worker()` helper an `owner: "6a732075133f935b19154cd2"` default so every
other test in the file keeps passing.

- [ ] **Step 2: Run them and watch the first fail**

Run: `./node_modules/.bin/vitest run src/lib/worker-service.test.ts -t "no owner"`
Expected: FAIL — the verdict is `ok: true`, because nothing looks at `owner` yet.

- [ ] **Step 3: Add the field**

`src/models/worker.ts`, directly after `approvedProjects`:

```ts
    // The person this machine belongs to, set from the account that approved its enrolment. Distinct
    // from `identity` below: identity is which machine acted, owner is whose machine it is.
    owner: { type: Schema.Types.ObjectId, ref: "User", default: null },
```

Add `owner?: string | null;` to `IWorker` in `src/types/index.ts` beside `identity`.

- [ ] **Step 4: Record it at registration**

`src/lib/worker-service.ts`, in `registerWorker`'s input type:

```ts
  // Whoever minted the enrolment token. Only used to name the machine's identity.
  owner?: string;
  // The account the machine belongs to, which is what the claim keys on.
  ownerId?: string;
```

Destructure it out with `owner` and set it inside `$set`:

```ts
  const { owner, ownerId, ...fields } = input;
```

```ts
      $set: {
        ...fields,
        ...(ownerId ? { owner: new Types.ObjectId(ownerId) } : {}),
        protocolVersion: PROTOCOL_VERSION,
```

Import `Types` from `mongoose` if the file does not already.

- [ ] **Step 5: Refuse an ownerless machine**

`src/lib/worker-service.ts`, in `verdictFor`, immediately after the `isApprovedFor` check:

```ts
  if (!worker.owner) {
    return { ok: false, reason: "this machine has no owner — re-approve it from the board" };
  }
```

- [ ] **Step 6: Pass the owner at approval**

`src/app/api/workers/enrolment/device/[userCode]/approve/route.ts`, in the `registerWorker` call:

```ts
    owner: user.fullName || user.username,
    ownerId: String(user._id),
```

- [ ] **Step 7: Run the tests**

Run: `./node_modules/.bin/vitest run src/lib/worker-service.test.ts`
Expected: PASS, all of them.

- [ ] **Step 8: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/models/worker.ts src/types/index.ts src/lib/worker-service.ts src/lib/worker-service.test.ts "src/app/api/workers/enrolment/device/[userCode]/approve/route.ts"
git commit -m "feat(workers): a machine belongs to the person who approved it (BP-358)"
```

---

### Task 2: A task remembers who assigned it

**Files:**
- Modify: `src/models/task.ts:37-42` (beside `assignee`)
- Modify: `src/lib/task-service.ts:224` (`createTask`)
- Modify: `src/lib/task-service.ts` (`updateTask`, where `updates` is built)
- Test: `src/lib/task-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Task.assignedBy: Types.ObjectId | null`, written by `createTask` and `updateTask` whenever `assignee` is written. Task 3 reads it.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/task-service.test.ts`:

```ts
/**
 * Assigning a task to yourself means "I am working on this" in every tracker. Under BP-358 a
 * machine takes its owner's work, so without recording who did the assigning there is no way to
 * tell that from "somebody handed this to my machine".
 */
describe("a task records who assigned it", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", execution: {} }),
    });
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    const task = { _id: "t1", taskNumber: 1, status: "doing", title: "x" };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(task),
      populate: () => ({ lean: () => Promise.resolve(task) }),
    });
    userFindOne.mockReturnValue({ lean: () => Promise.resolve({ _id: "u2", username: "kuba" }) });
  });

  it("stamps the actor when the assignee changes", async () => {
    await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toBe("actor");
  });

  it("stamps it when a task is unassigned, so the field never describes an older assignee", async () => {
    await updateTask("p1", "t1", { assignee: null }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toBe("actor");
  });

  it("leaves it alone when the edit touches no assignee", async () => {
    await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run src/lib/task-service.test.ts -t "records who assigned it"`
Expected: FAIL — `assignedBy` is undefined on the write.

- [ ] **Step 3: Add the field**

`src/models/task.ts`, directly after the `assignee` block:

```ts
    // Who set the assignee. A machine runs its owner's work, and "I assigned this to myself" has to
    // be distinguishable from "somebody handed this to my machine".
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
```

Add `assignedBy?: string | null;` to `ITask` in `src/types/index.ts` beside `assignee`.

- [ ] **Step 4: Write it from updateTask**

`src/lib/task-service.ts`, immediately after the whitelist loop that builds `updates`:

```ts
  if (updates.assignee !== undefined) updates.assignedBy = actorId;
```

- [ ] **Step 5: Write it from createTask**

`src/lib/task-service.ts:224`, beside `assignee: assigneeId`:

```ts
    assignee: assigneeId,
    assignedBy: assigneeId ? actorId : null,
```

- [ ] **Step 6: Run the tests**

Run: `./node_modules/.bin/vitest run src/lib/task-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/models/task.ts src/types/index.ts src/lib/task-service.ts src/lib/task-service.test.ts
git commit -m "feat(tasks): a task records who assigned it (BP-358)"
```

---

### Task 3: An agent is the hand-over

**Files:**
- Modify: `src/lib/agent-snapshot.ts:47-60` (`snapshotFor`)
- Test: `src/lib/agent-snapshot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `snapshotFor(projectId, taskAgentId)` returns `null` when `taskAgentId` is absent. Task 4 relies on a task with no agent never being claimed in the first place.

- [ ] **Step 1: Write the failing test**

In `src/lib/agent-snapshot.test.ts`:

```ts
// Choosing an agent is how work is handed to a machine, so no agent means a person is doing it.
// The old chain — task agent, then the project default, then the seeded "Default" — meant an empty
// field still ran something, and there was no way to say "not this one".
it("returns nothing when the task names no agent", async () => {
  expect(await snapshotFor("p1", null)).toBeNull();
});

it("still resolves the agent a task does name", async () => {
  const snapshot = await snapshotFor("p1", AGENT_ID);

  expect(snapshot?.name).toBe("Default");
});
```

- [ ] **Step 2: Run and watch the first fail**

Run: `./node_modules/.bin/vitest run src/lib/agent-snapshot.test.ts -t "names no agent"`
Expected: FAIL — a snapshot comes back, resolved from the project default.

- [ ] **Step 3: Strike the fallback**

`src/lib/agent-snapshot.ts`, replace the resolution block:

```ts
/**
 * The task's own agent, and nothing else. Choosing one is how a task is handed to a machine, so a
 * task naming none is a task a person is doing — the claim skips it rather than resolving a default
 * on its behalf. Before BP-358 this fell through the project default to the seeded "Default", which
 * is what made an empty field mean "whatever the project says" instead of "nobody".
 */
export async function snapshotFor(
  projectId: string,
  taskAgentId?: unknown
): Promise<AgentSnapshot | null> {
  const agentId = taskAgentId ? String(taskAgentId) : "";
  if (!agentId) return null;

  const agent = await Agent.findById(agentId).lean();
  if (!agent) return null;
```

Leave everything below that line untouched. Remove the now-unused `Project` import and the
`SEEDED_DEFAULT_NAME` import if nothing else in the file uses them.

- [ ] **Step 4: Run the tests**

Run: `./node_modules/.bin/vitest run src/lib/agent-snapshot.test.ts`
Expected: PASS. Existing tests that asserted the fallback will fail — delete them, and note in the
commit that the behaviour they pinned is the one being removed.

- [ ] **Step 5: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/lib/agent-snapshot.ts src/lib/agent-snapshot.test.ts
git commit -m "feat(agents): no agent means a person is doing it (BP-358)"
```

---

### Task 4: The claim keys on the owner

**Files:**
- Modify: `src/lib/task-service.ts:889-990` (`claimNextTask`)
- Modify: `src/app/api/projects/[projectId]/tasks/claim/route.ts:36-41`
- Test: `src/lib/task-service.test.ts`

**Interfaces:**
- Consumes: `Worker.owner` (Task 1), `Task.assignedBy` (Task 2).
- Produces: `claimNextTask(projectId, workerId, runId, identity, ownerId)` — the fifth argument is the machine's owner. Returns `null` when it is absent.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/task-service.test.ts`:

```ts
/**
 * A machine takes its owner's work and nothing else. Before BP-358 the filter keyed on one
 * nominated user per project, so every approved machine raced for that person's tasks and a
 * colleague's work could land on your Mac.
 *
 * The approval path for work somebody else assigned you is a separate change, so until it exists
 * the filter also requires that the owner did the assigning — failing closed rather than running
 * another person's choice unattended.
 */
describe("a machine claims its owner's work", () => {
  const OWNER = "6a732075133f935b19154cd2";
  const IDENTITY = "6a732075133f935b19154cd3";

  async function claimFilterFor(ownerId: string | null) {
    findOneAndUpdate.mockClear();
    await claimNextTask("p1", "w1", "r1", IDENTITY, ownerId);
    return findOneAndUpdate.mock.calls[0]?.[0];
  }

  it("asks only for tasks its owner assigned to themselves", async () => {
    const filter = await claimFilterFor(OWNER);
    const alternatives = filter.$and.find((c: Record<string, unknown>) => c.$or).$or;

    expect(alternatives).toContainEqual({ assignee: OWNER, assignedBy: OWNER });
  });

  it("still takes back the task its own run is resuming", async () => {
    const filter = await claimFilterFor(OWNER);
    const alternatives = filter.$and.find((c: Record<string, unknown>) => c.$or).$or;

    expect(alternatives).toContainEqual({ assignee: IDENTITY });
  });

  it("never asks for an unassigned task, which belongs to nobody", async () => {
    const filter = await claimFilterFor(OWNER);
    const alternatives = filter.$and.find((c: Record<string, unknown>) => c.$or).$or;

    expect(alternatives).not.toContainEqual({ assignee: null });
  });

  it("asks for a task that names an agent, because that is the hand-over", async () => {
    const filter = await claimFilterFor(OWNER);

    expect(filter.agent).toEqual({ $ne: null });
  });

  it("claims nothing at all for a machine with no owner", async () => {
    expect(await claimNextTask("p1", "w1", "r1", IDENTITY, null)).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run src/lib/task-service.test.ts -t "claims its owner's work"`
Expected: FAIL — `claimNextTask` takes four arguments and builds `claimable` from the nominee.

- [ ] **Step 3: Take the owner and drop the nominee**

`src/lib/task-service.ts`, in `claimNextTask`'s signature:

```ts
  identity?: string | null,
  // The machine's owner. A machine takes the work this person handed it, and nothing else.
  ownerId?: string | null
```

Replace the project projection, the `scope`/`nominee` derivation and the `claimable` block with:

```ts
  const project = await Project.findById(projectId, "columns").lean();
```

```ts
  if (!ownerId || !Types.ObjectId.isValid(ownerId)) return null;

  // Assigned to the owner *by* the owner. Somebody else assigning you work is a proposal, and the
  // surface for accepting one does not exist yet — so it is refused rather than run unattended.
  // A task the run is resuming is already assigned to the machine's identity, and without it a
  // release would hand back a task nothing could pick up again.
  const claimable = [
    { assignee: ownerId, assignedBy: ownerId },
    ...(identity ? [{ assignee: identity }] : []),
  ];
```

Delete the `isClaimScope`/`PROJECT_POLICY_DEFAULTS` derivation above it and the
`if (claimable.length === 0) return null;` guard, which can no longer be reached.

- [ ] **Step 4: Require an agent in the filter**

In the same `Task.findOneAndUpdate` filter, beside `status`:

```ts
      // Choosing an agent is the hand-over; a task naming none is one a person is doing
      agent: { $ne: null },
```

- [ ] **Step 5: Pass the owner from the route**

`src/app/api/projects/[projectId]/tasks/claim/route.ts`:

```ts
  const task = await claimNextTask(
    projectId,
    String(worker._id),
    runId,
    worker.identity ? String(worker.identity) : null,
    worker.owner ? String(worker.owner) : null
  );
```

- [ ] **Step 6: Run the tests**

Run: `./node_modules/.bin/vitest run src/lib/task-service.test.ts`
Expected: PASS. Existing claim tests that set up a nominee will fail — rewrite them to pass an
owner, keeping what each one was actually testing (blockers, columns, held runs).

- [ ] **Step 7: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/lib/task-service.ts src/lib/task-service.test.ts "src/app/api/projects/[projectId]/tasks/claim/route.ts"
git commit -m "feat(workers): a machine claims its owner's work, not a project nominee's (BP-358)"
```

---

### Task 5: The settings the model no longer has

**Files:**
- Modify: `src/models/project.ts:183,192` (`claimScope`, `claimAssignee`)
- Modify: `src/types/index.ts:505,521`
- Modify: `src/app/(app)/projects/[projectId]/settings/sections/WorkersSection.tsx`
- Test: `src/app/(app)/projects/[projectId]/settings/sections/WorkersSection.test.tsx` if one exists; otherwise the existing settings tests

**Interfaces:**
- Consumes: Task 4 no longer reads either field.
- Produces: nothing. This is removal.

- [ ] **Step 1: Write the failing test**

In the WorkersSection test file (create it following the shape of `PmAgentSection.test.tsx` if
absent):

```tsx
// Both settings described a routing model BP-358 replaced: one nominated user per project, and a
// switch widening the claim to unassigned work. A task now goes to the machine of the person it was
// assigned to, so neither has anything left to say.
it("offers neither a nominee nor a claim scope", () => {
  render(<WorkersSection projectId="p1" project={project} replaceProject={vi.fn()} isAdmin />);

  expect(screen.queryByText(/hand tasks over to/i)).toBeNull();
  expect(screen.queryByText(/tasks a worker may take/i)).toBeNull();
});

it("still offers the switch that enables workers at all", () => {
  render(<WorkersSection projectId="p1" project={project} replaceProject={vi.fn()} isAdmin />);

  expect(screen.getByText(/let workers run tasks for this project/i)).not.toBeNull();
});
```

- [ ] **Step 2: Run and watch the first fail**

Run: `./node_modules/.bin/vitest run src/app/\(app\)/projects/\[projectId\]/settings/sections/WorkersSection.test.tsx`
Expected: FAIL — both labels are on screen.

- [ ] **Step 3: Remove them from the schema and types**

`src/models/project.ts`: delete the `claimScope` line and the `claimAssignee` field with its
comment. `src/types/index.ts`: delete `claimScope: ClaimScope;` and the `claimAssignee` declaration
with its comment. Delete `ClaimScope`, `CLAIM_SCOPES` and `isClaimScope` if nothing references them
— check with `grep -rn "ClaimScope\|claimScope\|claimAssignee" src worker mcp-server`.

- [ ] **Step 4: Remove them from the settings screen**

In `WorkersSection.tsx`: delete the `claimScope` entry from `LABELS` and from the policy field list,
delete the whole "Hand tasks over to" block, and reduce the enable switch's `hint` to a single
sentence:

```tsx
              hint="A task goes to the machine of the person it is assigned to, once it names an agent."
```

- [ ] **Step 5: Run the tests**

Run: `./node_modules/.bin/vitest run`
Expected: PASS. Anything still naming the removed fields fails here — fix each by deleting the
assertion, not by reinstating the field.

- [ ] **Step 6: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/models/project.ts src/types/index.ts "src/app/(app)/projects/[projectId]/settings/sections/"
git commit -m "refactor(workers): drop the project nominee and claim scope (BP-358)

A project set to claimScope 'any' took unassigned tasks and now will not: work
goes to the machine of the person it is assigned to. Release note, not only a
schema change."
```

---

### Task 6: The picker says nobody will take it

**Files:**
- Modify: `src/components/tasks/detail/PropertyRail.tsx` (the Agent row)
- Test: `src/components/tasks/detail/PropertyRail.test.tsx`

**Interfaces:**
- Consumes: Task 3 — an empty agent now genuinely means no run.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

In `PropertyRail.test.tsx`, inside the existing Agent describe:

```tsx
// "Project default" was honest while an empty field fell back to the project's agent. Since BP-358
// it means nobody takes the task, and the label has to say so — this is the only signal that a task
// is one a person is doing.
it("names the empty option for what it now means", async () => {
  renderRail({ agents: AGENTS });

  expect(screen.getByText("Agent").closest("div")?.textContent).toContain("No agent");
});

it("offers it as the first choice, so handing work to a machine stays deliberate", async () => {
  renderRail({ agents: AGENTS });
  await openRow("Agent");

  expect(screen.getAllByRole("option")[0].textContent).toContain("No agent");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `./node_modules/.bin/vitest run src/components/tasks/detail/PropertyRail.test.tsx -t "empty option"`
Expected: FAIL — the text reads "Project default".

- [ ] **Step 3: Rename it, in both branches of the row**

In the admin `ComboboxRow`:

```tsx
            emptyOption="No agent — a person does it"
```

```tsx
              <EmptyValue>No agent</EmptyValue>
```

And in the read-only `FieldRow` below it, the same `<EmptyValue>No agent</EmptyValue>`.

- [ ] **Step 4: Run the tests**

Run: `./node_modules/.bin/vitest run src/components/tasks/detail/PropertyRail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Give the project default its remaining job**

Task 3 stopped `snapshotFor` reading `project.worker.agent`, and a new task starts with no agent, so
the setting has nothing left to do unless the picker uses it. The spec keeps it as a convenience —
the agent offered first once somebody has decided to hand the task over. Order the options so it is:

```tsx
            options={[...agents]
              .sort((a, b) =>
                a._id === projectDefaultAgent ? -1 : b._id === projectDefaultAgent ? 1 : 0
              )
              .map((a) => ({ value: a._id, label: a.name }))}
```

`projectDefaultAgent` is a new optional prop on `PropertyRail`, `projectDefaultAgent?: string`,
passed from `TaskDetail` as `project.worker?.agent`. The empty option stays first regardless —
`ComboboxRow` renders `emptyOption` above the list.

Test it, in the same describe:

```tsx
// The project's default stops being what runs and becomes what is offered first. Without this the
// setting has no job at all once the fallback is gone.
it("offers the project's default ahead of the other agents", async () => {
  renderRail({ agents: AGENTS, projectDefaultAgent: "a2" });
  await openRow("Agent");

  const options = screen.getAllByRole("option").map((o) => o.textContent);
  expect(options[0]).toContain("No agent");
  expect(options[1]).toContain("With security review");
});
```

- [ ] **Step 6: Confirm a new task starts with none**

`createTask` never reads `body.agent`, so a new task's `agent` is already `null` and the picker
already shows the empty option first. Verify rather than assume:

Run: `./node_modules/.bin/vitest run src/lib/task-service.test.ts -t "createTask"`
Expected: PASS, and `grep -n "agent" src/lib/task-service.ts` shows no read of `body.agent` in
`createTask`. If one has appeared, delete it — handing work to a machine must be a separate act.

- [ ] **Step 7: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/components/tasks/detail/PropertyRail.tsx src/components/tasks/detail/PropertyRail.test.tsx src/components/tasks/TaskDetail.tsx
git commit -m "feat(tasks): the agent picker says when nobody will take it (BP-358)"
```

---

## What this plan deliberately leaves undone

**The board badge.** The spec notes that "waiting on Rafał's Mac" is computable from what is already
stored — assignee, a live machine on the project, an approved column. It is a display affordance
rather than part of the mechanism, and it belongs with the consent surface, where there is something
to wait *for*.

**The consent surface.** A task somebody **else** assigned you does not run, because Task 4's filter
requires `assignedBy === owner`. That is the fail-closed half of the design; the other half — the
worker offering pending requests, a socket route that starts work, and the approval UI in the
menubar app showing the proposed agent with the owner able to swap it — is its own plan, against
`worker/` and `menubar/` rather than the web app.

Write that plan only once this one has landed, because until routing is settled there is nothing
well-defined for the app to poll.
