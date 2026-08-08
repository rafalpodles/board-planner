# PM Phase 2 — Autonomous Triggers Implementation Plan (CP-121)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** DRAFT — awaiting rpo's approval (CP-121 is `planned`, size L; per CLAUDE.md no code is written until this plan is approved).

**Goal:** Make the PM agent act without being spoken to — a daily scheduled board review per project, and an automatic review whenever a task enters `needs_human_review`.

**Architecture:** `runPmTurn` is already HTTP-free, so both triggers are just new callers. A durable trigger queue (`pmtriggers` collection) plus an in-process interval started from `src/instrumentation.ts` drives them. Status-change events try to run immediately and fall back to the queue when the project's turn lock is busy, so a trigger is never silently lost. All autonomous turns write into the same per-project `PmMessage` thread the chat widget already renders, tagged with a `trigger` field so the UI can distinguish them from human messages.

**Tech Stack:** Next.js 16 App Router, TypeScript, Mongoose/MongoDB, existing `src/lib/pm/*` (openrouter client, tool registry, agent loop, turn lock). No new dependencies — timezone handling uses built-in `Intl`.

## Global Constraints

- **No new dependencies.** `Intl.DateTimeFormat` covers timezone math; `mongoose` covers atomic claims.
- **Single Railway instance is the normal case, but never assume it.** Every "run once" decision must be an atomic MongoDB claim, because rolling deploys briefly overlap two instances.
- **PM guardrails are unchanged:** tasks are still created only in `planned`, `MAX_WRITE_ACTIONS = 10` and `MAX_STEPS = 15` per turn still apply. Autonomous turns get no extra powers.
- **Autonomous turns count against `pm.dailyTurnCap`** (default `PM_DAILY_TURN_CAP`, fallback 100), using the same "user-role messages created today" counter as chat.
- **Never block a user request.** Status-change hooks are fire-and-forget, exactly like `logActivity` / `dispatchWebhooks` in `src/lib/task-service.ts`.
- **Opt-in per project.** With `pm.autonomy` absent or disabled, behaviour is byte-for-byte what it is today.
- Code, comments, commit messages in English. Conventional commits. No `Co-Authored-By` trailer.
- Comments only where the code cannot explain itself (see the user's global CLAUDE.md).

## Testing approach (read before Task 1)

This repo has **no test framework** (`package.json` has `dev`/`build`/`lint` only, zero devDeps beyond `@types/nodemailer`), and the established convention for the PM subsystem is "Acceptance (verified live in the UI)" — see `docs/superpowers/specs/2026-07-20-pm-agent-core-design.md`.

This plan therefore uses two verification modes, and each task states which one applies:

- **Logic check** — for pure functions, a throwaway script under the session scratchpad run with `node`, printing `PASS`/`FAIL` lines. No framework, no new deps, nothing committed. Every such script is written out in full in the task.
- **Live check** — drive the real UI/board end-to-end against a local MongoDB, per the user's global preference. Setup: `.env.local` with `MONGODB_URI=mongodb://localhost:27017/boardplanner`, `npm run dev`, log in, click through.

**Open decision for rpo at approval time:** add `vitest` as a devDependency and write real unit tests for `src/lib/pm/autonomy.ts` and the claim logic instead of throwaway scripts. It is the right long-term call for scheduling code, but it introduces test infrastructure this repo has deliberately not had, so it is your decision, not mine. The plan below assumes **no vitest**; if you approve it, Tasks 1, 4 and 6 gain a proper test file each and lose their scratch scripts.

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/lib/pm/autonomy.ts` | Pure, side-effect-free: timezone hour/day-key helpers, `shouldRunDailyReview`, the two autonomous prompt builders. Everything here is decidable from its arguments. |
| `src/models/pmTrigger.ts` | `pmtriggers` collection — the durable queue of pending event triggers, with the partial unique index that gives idempotency. |
| `src/lib/pm/triggers.ts` | Trigger lifecycle: `enqueuePmTrigger`, `claimPmTrigger`, `runPmTrigger`, `drainPmTriggers`, and `onTaskStatusChanged` (the hook task-service calls). |
| `src/lib/pm/scheduler.ts` | The in-process loop: `startPmScheduler`, `pmSchedulerTick`, `runDailyReviewFor`. Owns the atomic day-claim. |
| `src/lib/pm/turn-cap.ts` | `isOverDailyTurnCap(projectId, pmConfig)` — extracted from the chat route so scheduler and route share one definition. |

**Modified files**

| File | Change |
|---|---|
| `src/types/index.ts` | `IPmAutonomy`, `ApiPmAutonomy`, `PmTriggerType`, `IPmTrigger`, `PmMessageTrigger`; `autonomy?` on `IPmConfig`/`ApiPmConfig`; `trigger` on `IPmMessage`/`ApiPmMessage`. |
| `src/models/project.ts` | `pm.autonomy` subdocument. |
| `src/models/pmMessage.ts` | `trigger` subdocument. |
| `src/lib/pm/config.ts` | Validate `pm.autonomy` inside `validatePmConfig`. |
| `src/lib/pm/agent.ts` | `runPmTurn` accepts a `trigger` and stamps it on both messages. |
| `src/app/api/projects/[projectId]/pm/chat/route.ts` | Use `isOverDailyTurnCap`. |
| `src/lib/task-service.ts` | Call `onTaskStatusChanged` from **both** `changeStatus` and `updateTask`. |
| `src/instrumentation.ts` | `startPmScheduler()` after the DB connects. |
| `src/app/projects/[projectId]/settings/page.tsx` | "Autonomy" controls in the existing PM Agent section. |
| `src/components/pm/PmChat.tsx` | Badge on auto-triggered messages. |

---

## Task 1: Autonomy config — types, schema, validation, settings UI

Pure configuration. After this task the settings round-trip works and nothing else changes behaviour.

**Files:**
- Modify: `src/types/index.ts` (near `IPmConfig`, ~line 255)
- Modify: `src/models/project.ts:84-95` (the `pm` subdocument)
- Modify: `src/lib/pm/config.ts:14-142` (`validatePmConfig`)
- Modify: `src/app/projects/[projectId]/settings/page.tsx` (PM Agent section, ~line 919; state ~line 65; save payload ~line 154)
- Create: `src/lib/pm/autonomy.ts` (timezone helpers only; the rest lands in Task 6)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `IPmAutonomy = { dailyReview: boolean; reviewHour: number; timezone: string; handleNeedsHumanReview: boolean; lastDailyReviewDay: string }`
  - `DEFAULT_PM_AUTONOMY: IPmAutonomy`
  - `hourInTimezone(date: Date, timeZone: string): number`
  - `dayKeyInTimezone(date: Date, timeZone: string): string` — `"YYYY-MM-DD"`
  - `isValidTimezone(tz: string): boolean`

- [ ] **Step 1: Add the types**

In `src/types/index.ts`, directly above `export interface IPmConfig`:

```typescript
export interface IPmAutonomy {
  dailyReview: boolean;
  reviewHour: number;
  timezone: string;
  handleNeedsHumanReview: boolean;
  lastDailyReviewDay: string;
}

export const DEFAULT_PM_AUTONOMY: IPmAutonomy = {
  dailyReview: false,
  reviewHour: 9,
  timezone: "Europe/Warsaw",
  handleNeedsHumanReview: false,
  lastDailyReviewDay: "",
};
```

Add `autonomy?: IPmAutonomy;` to `IPmConfig` and `autonomy?: IPmAutonomy;` to `ApiPmConfig` (the API shape is identical — `lastDailyReviewDay` is not a secret and is useful in the UI).

- [ ] **Step 2: Add the schema**

In `src/models/project.ts`, inside the `pm` subdocument after `dailyTurnCap`:

```typescript
      autonomy: {
        dailyReview: { type: Boolean, default: false },
        reviewHour: { type: Number, default: 9, min: 0, max: 23 },
        timezone: { type: String, default: "Europe/Warsaw" },
        handleNeedsHumanReview: { type: Boolean, default: false },
        lastDailyReviewDay: { type: String, default: "" },
      },
```

- [ ] **Step 3: Create the timezone helpers**

Create `src/lib/pm/autonomy.ts`:

```typescript
export function hourInTimezone(date: Date, timeZone: string): number {
  const value = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return Number(value);
}

export function dayKeyInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Logic check the helpers**

Write `<scratchpad>/tz-check.js` and run `node <scratchpad>/tz-check.js`:

```javascript
const { hourInTimezone, dayKeyInTimezone, isValidTimezone } = require("./tz-compiled.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// 2026-07-28T22:30:00Z is 2026-07-29 00:30 in Warsaw (UTC+2 in summer)
const summerNight = new Date("2026-07-28T22:30:00Z");
check("summer hour Warsaw", hourInTimezone(summerNight, "Europe/Warsaw"), 0);
check("summer day Warsaw", dayKeyInTimezone(summerNight, "Europe/Warsaw"), "2026-07-29");
check("summer day UTC", dayKeyInTimezone(summerNight, "UTC"), "2026-07-28");

// 2026-01-15T23:30:00Z is 2026-01-16 00:30 in Warsaw (UTC+1 in winter)
const winterNight = new Date("2026-01-15T23:30:00Z");
check("winter hour Warsaw", hourInTimezone(winterNight, "Europe/Warsaw"), 0);
check("winter day Warsaw", dayKeyInTimezone(winterNight, "Europe/Warsaw"), "2026-01-16");

// midnight must be 0, never 24
check("midnight is 0", hourInTimezone(new Date("2026-07-28T00:00:00Z"), "UTC"), 0);
check("valid tz", isValidTimezone("Europe/Warsaw"), true);
check("invalid tz", isValidTimezone("Mars/Olympus"), false);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

Compile the module for the script first (the repo has no runtime TS loader):

```bash
npx tsc src/lib/pm/autonomy.ts --outDir <scratchpad> --module commonjs --target es2022
```

Then rename the emitted `autonomy.js` to `tz-compiled.js` next to the script.
Expected: `ALL PASS`. The `midnight is 0` case is the one that fails if `hourCycle: "h23"` is dropped — do not remove it.

- [ ] **Step 5: Validate the config**

In `src/lib/pm/config.ts`, import `DEFAULT_PM_AUTONOMY`, `IPmAutonomy` from `@/types` and `isValidTimezone` from `./autonomy`. Insert before the final `return`:

```typescript
  const rawAutonomy = pm.autonomy ?? {};
  if (typeof rawAutonomy !== "object" || rawAutonomy === null || Array.isArray(rawAutonomy)) {
    return { valid: false, error: "pm.autonomy must be an object" };
  }
  const reviewHour = rawAutonomy.reviewHour ?? DEFAULT_PM_AUTONOMY.reviewHour;
  if (!Number.isInteger(reviewHour) || reviewHour < 0 || reviewHour > 23) {
    return { valid: false, error: "pm.autonomy.reviewHour must be an integer 0-23" };
  }
  const timezone = String(rawAutonomy.timezone ?? DEFAULT_PM_AUTONOMY.timezone).trim();
  if (!isValidTimezone(timezone)) {
    return { valid: false, error: `pm.autonomy.timezone is not a valid IANA timezone: ${timezone}` };
  }
  const autonomy: IPmAutonomy = {
    dailyReview: rawAutonomy.dailyReview === true,
    reviewHour,
    timezone,
    handleNeedsHumanReview: rawAutonomy.handleNeedsHumanReview === true,
    lastDailyReviewDay: "",
  };
```

Add `autonomy,` to the returned `value` object.

`lastDailyReviewDay` is deliberately forced to `""` here: it is server-managed state, and the PUT body must never be able to set it. It must then be preserved on save, exactly like the `mcpServers` carry-over that already lives in the route.

In `src/app/api/projects/[projectId]/route.ts:57`, widen the existing projection and add the carry-over just before `updates.pm = pmResult.value;` (line 71):

```typescript
    const existing = await Project.findById(projectId).select("pm.mcpServers pm.autonomy");
```

```typescript
    if (body.pm.autonomy === undefined && existing.pm?.autonomy) {
      // Clients unaware of autonomy must not silently disable the scheduled review
      pmResult.value.autonomy = existing.pm.autonomy;
    } else if (pmResult.value.autonomy) {
      pmResult.value.autonomy.lastDailyReviewDay =
        existing.pm?.autonomy?.lastDailyReviewDay ?? "";
    }
```

Two failure modes, both found during Task 1's verification: without the `else if` branch every settings save resets the marker and the daily review fires a second time that day; without the first branch a client that omits `autonomy` (a script, a stale cached page) silently turns the scheduled review off. The first branch mirrors the `mcpServers` guard already in this route, for the same reason.

- [ ] **Step 6: Add the settings UI**

In `src/app/projects/[projectId]/settings/page.tsx`, next to the existing PM state (~line 65):

```typescript
  const [pmDailyReview, setPmDailyReview] = useState(false);
  const [pmReviewHour, setPmReviewHour] = useState("9");
  const [pmTimezone, setPmTimezone] = useState("Europe/Warsaw");
  const [pmHandleNhr, setPmHandleNhr] = useState(false);
```

In the loader next to `setPmDailyCap(...)` (~line 95):

```typescript
        setPmDailyReview(p.pm?.autonomy?.dailyReview ?? false);
        setPmReviewHour(String(p.pm?.autonomy?.reviewHour ?? 9));
        setPmTimezone(p.pm?.autonomy?.timezone || "Europe/Warsaw");
        setPmHandleNhr(p.pm?.autonomy?.handleNeedsHumanReview ?? false);
```

In the save payload next to `dailyTurnCap` (~line 158):

```typescript
          autonomy: {
            dailyReview: pmDailyReview,
            reviewHour: Number(pmReviewHour) || 0,
            timezone: pmTimezone.trim(),
            handleNeedsHumanReview: pmHandleNhr,
          },
```

In the PM Agent section markup (~line 960, after the contextNotes textarea):

```tsx
              <div className="border-t border-border pt-3 mt-3 space-y-3">
                <h3 className="text-sm font-medium">Autonomy</h3>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={pmDailyReview}
                    onChange={(e) => setPmDailyReview(e.target.checked)}
                    className="rounded border-border"
                  />
                  Daily board review
                </label>
                {pmDailyReview && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-6">
                    <div>
                      <label className="block text-sm font-medium mb-1">Review hour</label>
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={pmReviewHour}
                        onChange={(e) => setPmReviewHour(e.target.value)}
                        className="w-full bg-bg-input border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Timezone</label>
                      <input
                        type="text"
                        value={pmTimezone}
                        onChange={(e) => setPmTimezone(e.target.value)}
                        placeholder="Europe/Warsaw"
                        className="w-full bg-bg-input border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={pmHandleNhr}
                    onChange={(e) => setPmHandleNhr(e.target.checked)}
                    className="rounded border-border"
                  />
                  Review tasks entering &quot;Needs Human Review&quot;
                </label>
                <p className="text-xs text-text-muted">
                  Autonomous turns count against the daily turn cap and post into the PM chat thread.
                </p>
              </div>
```

- [ ] **Step 7: Live check**

Run `npm run build`, then `npm run dev`. Open project settings → PM Agent. Enable "Daily board review", set hour `14`, timezone `Europe/Warsaw`, tick the needs-human-review checkbox, save, reload the page. Expected: all four values come back. Then save an invalid timezone (`Mars/Olympus`). Expected: the save is rejected with `pm.autonomy.timezone is not a valid IANA timezone: Mars/Olympus` and nothing is persisted.

- [ ] **Step 8: Commit**

```bash
git add src/types/index.ts src/models/project.ts src/lib/pm/config.ts src/lib/pm/autonomy.ts "src/app/projects/[projectId]/settings/page.tsx" "src/app/api/projects/[projectId]/route.ts"
git commit -m "feat(pm): add per-project autonomy config"
```

---

## Task 2: Tag PM messages with their trigger

Autonomous turns must be visually distinguishable from messages rpo typed. After this task chat still behaves identically, but every message carries a trigger tag.

**Files:**
- Modify: `src/types/index.ts` (near `IPmMessage`, ~line 291)
- Modify: `src/models/pmMessage.ts:4-21`
- Modify: `src/lib/pm/agent.ts:68-104`
- Modify: `src/components/pm/PmChat.tsx` (message rendering, ~line 289)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `PmTriggerType = "chat" | "daily_review" | "needs_human_review"`
  - `PmMessageTrigger = { type: PmTriggerType; taskKey?: string }`
  - `runPmTurn` gains `trigger?: PmMessageTrigger`

- [ ] **Step 1: Add the types**

In `src/types/index.ts` above `IPmMessage`:

```typescript
export const PM_TRIGGER_TYPES = ["chat", "daily_review", "needs_human_review"] as const;
export type PmTriggerType = (typeof PM_TRIGGER_TYPES)[number];

export interface PmMessageTrigger {
  type: PmTriggerType;
  taskKey?: string;
}
```

Add `trigger: PmMessageTrigger;` to `IPmMessage` and to `ApiPmMessage`.

- [ ] **Step 2: Add the schema field**

In `src/models/pmMessage.ts`, declare the subdocument as its own schema above `pmMessageSchema`:

```typescript
// Separate schema: an inline subdocument with a field named "type" collides with Mongoose's typeKey
const triggerSchema = new Schema<PmMessageTrigger>(
  {
    type: { type: String, enum: PM_TRIGGER_TYPES, default: "chat" },
    taskKey: { type: String, default: "" },
  },
  { _id: false }
);
```

then, inside `pmMessageSchema` after `actions`:

```typescript
    trigger: {
      type: triggerSchema,
      default: () => ({ type: "chat", taskKey: "" }),
    },
```

Import `PmMessageTrigger` and `PM_TRIGGER_TYPES` from `@/types`.

An inline subdocument does **not** work here. Declaring it inline makes Mongoose read the nested `type` key as the SchemaType declaration for `trigger` itself, and the build dies with `Invalid schema configuration: 'Default' is not a valid type at path 'trigger.default'`. A separate schema sidesteps the ambiguity; `_id: false` keeps the subdocument from growing its own ObjectId.

- [ ] **Step 3: Thread the trigger through the agent**

In `src/lib/pm/agent.ts`, add `trigger` to the `runPmTurn` signature:

```typescript
export async function runPmTurn(opts: {
  projectId: string;
  userMessage: string;
  triggeredByUserId: string;
  trigger?: PmMessageTrigger;
  onEvent?: (event: PmTurnEvent) => void;
}): Promise<PmTurnResult> {
```

`triggeredByUserId` stays a required `string` — autonomous callers pass the `pm` user's id, so there is no null case to widen the type for.

Import `PmMessageTrigger` from `@/types`. Add `const trigger = opts.trigger ?? { type: "chat" as const };` after the `pmUser` lookup, and pass `trigger` into both `PmMessage.create` calls (the user stub and the assistant stub) alongside the existing fields.

- [ ] **Step 4: Badge auto-triggered messages in the UI**

In `src/components/pm/PmChat.tsx`, inside the message map (~line 289), directly above `<ActionChips actions={m.actions} />`:

```tsx
              {m.trigger && m.trigger.type !== "chat" && (
                <span className="inline-flex items-center gap-1 text-[10px] text-text-muted bg-bg-input rounded-full px-2 py-0.5 mb-1">
                  {m.trigger.type === "daily_review"
                    ? "Scheduled review"
                    : `Auto review: ${m.trigger.taskKey}`}
                </span>
              )}
```

In the optimistic user message (~line 118), add `trigger: { type: "chat" as const }` so the optimistic and persisted shapes match.

- [ ] **Step 5: Live check**

`npm run build` then `npm run dev`. Send a normal chat message to the PM. Expected: it works exactly as before and shows **no** badge. Check MongoDB: `db.pmmessages.find().sort({createdAt:-1}).limit(2)` — both new documents have `trigger: { type: "chat", taskKey: "" }`. Reload the page; history renders unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/models/pmMessage.ts src/lib/pm/agent.ts src/components/pm/PmChat.tsx
git commit -m "feat(pm): tag messages with the trigger that produced them"
```

---

## Task 3: Extract the daily turn cap

The cap currently lives inline in the chat route. The scheduler needs the same rule, and two copies of a rate limit is how they drift.

**Files:**
- Create: `src/lib/pm/turn-cap.ts`
- Modify: `src/app/api/projects/[projectId]/pm/chat/route.ts:13`, `:77-90`

**Interfaces:**
- Consumes: nothing.
- Produces: `isOverDailyTurnCap(projectId: string, pm: { dailyTurnCap?: number }): Promise<{ over: boolean; cap: number; used: number }>`

- [ ] **Step 1: Create the module**

```typescript
import { PmMessage } from "@/models/pmMessage";

const FALLBACK_DAILY_TURN_CAP = 100;

export async function isOverDailyTurnCap(
  projectId: string,
  pm: { dailyTurnCap?: number }
): Promise<{ over: boolean; cap: number; used: number }> {
  const cap = pm.dailyTurnCap || Number(process.env.PM_DAILY_TURN_CAP) || FALLBACK_DAILY_TURN_CAP;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const used = await PmMessage.countDocuments({
    project: projectId,
    role: "user",
    createdAt: { $gte: startOfDay },
  });
  return { over: used >= cap, cap, used };
}
```

This preserves today's semantics exactly, including the server-local day boundary. Autonomous turns create a `role: "user"` message, so they are counted with no further work.

- [ ] **Step 2: Use it in the chat route**

Delete the `DAILY_TURN_CAP` constant (line 13) and replace lines 77-90 with:

```typescript
  const { over, cap } = await isOverDailyTurnCap(projectId, project.pm);
  if (over) {
    return NextResponse.json(
      { error: `Daily PM turn cap (${cap}) reached for this project` },
      { status: 429 }
    );
  }
```

Import `isOverDailyTurnCap` from `@/lib/pm/turn-cap`.

- [ ] **Step 3: Live check**

`npm run build`, `npm run dev`. In project settings set the PM daily turn cap to `1`. Send one chat message (succeeds), then a second. Expected: the second is refused with `Daily PM turn cap (1) reached for this project` and HTTP 429. Restore the cap to blank afterwards.

- [ ] **Step 4: Commit**

```bash
git add src/lib/pm/turn-cap.ts "src/app/api/projects/[projectId]/pm/chat/route.ts"
git commit -m "refactor(pm): extract the daily turn cap check"
```

---

## Task 4: Trigger queue — model and enqueue on status change

Enqueue only. Nothing executes yet, which makes the hook independently verifiable.

**Files:**
- Create: `src/models/pmTrigger.ts`
- Create: `src/lib/pm/triggers.ts`
- Modify: `src/types/index.ts`
- Modify: `src/lib/task-service.ts` (`changeStatus` ~line 139, `updateTask` ~line 246)

**Interfaces:**
- Consumes: `IPmAutonomy` (Task 1).
- Produces:
  - `IPmTrigger = { _id; project; type: "needs_human_review"; taskKey: string; task: ObjectId; state: "pending" | "running" | "done" | "failed"; attempts: number; lastError: string; createdAt; updatedAt }`
  - `enqueuePmTrigger(projectId: string, taskId: string, taskKey: string): Promise<void>`
  - `onTaskStatusChanged(args: { projectId: string; taskId: string; oldStatus: string; newStatus: string; actorId: string }): Promise<void>`

- [ ] **Step 1: Add the type**

In `src/types/index.ts`:

```typescript
export const PM_TRIGGER_STATES = ["pending", "running", "done", "failed"] as const;
export type PmTriggerState = (typeof PM_TRIGGER_STATES)[number];

export interface IPmTrigger {
  _id: Types.ObjectId;
  project: Types.ObjectId;
  type: "needs_human_review";
  taskKey: string;
  task: Types.ObjectId;
  state: PmTriggerState;
  attempts: number;
  lastError: string;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 2: Create the model**

`src/models/pmTrigger.ts`:

```typescript
import mongoose, { Schema, Model } from "mongoose";
import { IPmTrigger, PM_TRIGGER_STATES } from "@/types";

const pmTriggerSchema = new Schema<IPmTrigger>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    type: { type: String, enum: ["needs_human_review"], required: true },
    taskKey: { type: String, required: true },
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    state: { type: String, enum: PM_TRIGGER_STATES, default: "pending" },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

pmTriggerSchema.index({ state: 1, createdAt: 1 });
pmTriggerSchema.index(
  { project: 1, task: 1 },
  { unique: true, partialFilterExpression: { state: { $in: ["pending", "running"] } } }
);

export const PmTrigger: Model<IPmTrigger> =
  mongoose.models.PmTrigger || mongoose.model<IPmTrigger>("PmTrigger", pmTriggerSchema);
```

The partial unique index is the idempotency guarantee: a task can have at most one un-finished trigger, so a task bounced in and out of `needs_human_review` twice in a minute produces one review, not two.

- [ ] **Step 3: Create the enqueue + hook**

`src/lib/pm/triggers.ts`:

```typescript
import { Project } from "@/models/project";
import { PmTrigger } from "@/models/pmTrigger";
import { getPmUser } from "./pm-user";

export async function enqueuePmTrigger(
  projectId: string,
  taskId: string,
  taskKey: string
): Promise<void> {
  try {
    await PmTrigger.create({
      project: projectId,
      type: "needs_human_review",
      taskKey,
      task: taskId,
      state: "pending",
    });
  } catch (err) {
    // Duplicate key = a trigger for this task is already queued or running
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

export async function onTaskStatusChanged(args: {
  projectId: string;
  taskId: string;
  oldStatus: string;
  newStatus: string;
  actorId: string;
}): Promise<void> {
  if (args.newStatus !== "needs_human_review" || args.oldStatus === "needs_human_review") return;

  const project = await Project.findById(args.projectId, "key pm").lean();
  if (!project?.pm?.enabled || !project.pm.autonomy?.handleNeedsHumanReview) return;

  const pmUser = await getPmUser();
  if (String(pmUser._id) === args.actorId) return;

  const task = await Task.findById(args.taskId, "taskNumber").lean();
  if (!task) return;

  await enqueuePmTrigger(args.projectId, args.taskId, `${project.key}-${task.taskNumber}`);
}
```

Import `Task` from `@/models/task` at the top. The `actorId` check is the loop guard: when the PM itself parks a task in `needs_human_review`, it must not then wake itself up to review it.

- [ ] **Step 4: Call the hook from both status paths**

`updateTask` and `changeStatus` are **both** live status-change paths — the board and the list-view dropdown use `PATCH .../status` (`changeStatus`), while the task edit form sends `status` inside the `PUT` body (`updateTask`). A hook on only one of them silently misses half the transitions.

In `src/lib/task-service.ts`, inside `changeStatus`, within the existing `if (oldTask.status !== status) {` block, after the `createNotifications({...})` call:

```typescript
    onTaskStatusChanged({
      projectId,
      taskId,
      oldStatus: oldTask.status,
      newStatus: status,
      actorId,
    }).catch((err) => console.error("PM status trigger failed:", err));
```

In `updateTask`, after `await Promise.all(activities);`:

```typescript
  if (updates.status !== undefined && oldTask.status !== task.status) {
    onTaskStatusChanged({
      projectId,
      taskId,
      oldStatus: oldTask.status,
      newStatus: task.status,
      actorId,
    }).catch((err) => console.error("PM status trigger failed:", err));
  }
```

Import `onTaskStatusChanged` from `@/lib/pm/triggers`. Both calls are deliberately un-awaited — same fire-and-forget contract as `dispatchWebhooks` above them.

- [ ] **Step 5: Live check**

`npm run build`, `npm run dev`. Enable the PM agent and "Review tasks entering Needs Human Review" for the test project.

1. Drag a task on the board into **Needs Human Review**. Check MongoDB: `db.pmtriggers.find()` → exactly one `pending` document with the right `taskKey`.
2. Drag it out and back in. Expected: still exactly one `pending` document (the partial unique index held).
3. Open a different task, edit it in the form, set status to Needs Human Review, save. Expected: a second `pending` document for that task — this is the `updateTask` path, and it proves the hook is on both routes.
4. Turn the setting off, move a third task in. Expected: no new document.
5. Delete the test documents: `db.pmtriggers.deleteMany({})`.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/models/pmTrigger.ts src/lib/pm/triggers.ts src/lib/task-service.ts
git commit -m "feat(pm): queue a review trigger when a task needs human review"
```

---

## Task 5: Execute review triggers

**Files:**
- Modify: `src/lib/pm/triggers.ts`
- Modify: `src/lib/pm/autonomy.ts`

**Interfaces:**
- Consumes: `enqueuePmTrigger` (Task 4), `runPmTurn` with `trigger` (Task 2), `isOverDailyTurnCap` (Task 3), `acquireTurnLock`/`releaseTurnLock` (`src/lib/pm/turn-lock.ts`).
- Produces:
  - `buildNeedsHumanReviewPrompt(taskKey: string): string`
  - `runPmTrigger(trigger: IPmTrigger): Promise<void>`
  - `drainPmTriggers(): Promise<void>`

- [ ] **Step 1: Write the prompt builder**

Append to `src/lib/pm/autonomy.ts`:

```typescript
export function buildNeedsHumanReviewPrompt(taskKey: string): string {
  return [
    `Task ${taskKey} was just moved to "needs_human_review".`,
    ``,
    `Read it with get_task and read its comments with list_comments. Then do exactly one of:`,
    `1. If the blocker is answerable from the board and project context, add a comment with your answer and reasoning, and move the task to the status you judge correct.`,
    `2. If it needs a decision only rpo can make, add a comment stating the ONE specific question and the options you see, and leave the status alone.`,
    ``,
    `Do not restate the task description back to us. Be concise and concrete.`,
    `Finish with a one-line summary of which of the two you did and why.`,
  ].join("\n");
}
```

- [ ] **Step 2: Write the executor**

Append to `src/lib/pm/triggers.ts`:

```typescript
const MAX_TRIGGER_ATTEMPTS = 3;

export async function runPmTrigger(trigger: IPmTrigger): Promise<void> {
  const projectId = String(trigger.project);
  const project = await Project.findById(projectId, "pm").lean();
  if (!project?.pm?.enabled || !project.pm.autonomy?.handleNeedsHumanReview) {
    await PmTrigger.findByIdAndUpdate(trigger._id, { $set: { state: "done" } });
    return;
  }

  const { over, cap } = await isOverDailyTurnCap(projectId, project.pm);
  if (over) {
    await PmTrigger.findByIdAndUpdate(trigger._id, {
      $set: { state: "failed", lastError: `Daily turn cap (${cap}) reached` },
    });
    return;
  }

  if (!acquireTurnLock(projectId)) {
    await PmTrigger.findByIdAndUpdate(trigger._id, { $set: { state: "pending" } });
    return;
  }

  try {
    const result = await runPmTurn({
      projectId,
      userMessage: buildNeedsHumanReviewPrompt(trigger.taskKey),
      triggeredByUserId: String((await getPmUser())._id),
      trigger: { type: "needs_human_review", taskKey: trigger.taskKey },
    });
    if (result.ok) {
      await PmTrigger.findByIdAndUpdate(trigger._id, { $set: { state: "done", lastError: "" } });
    } else {
      await failTrigger(trigger, result.error ?? "PM turn failed");
    }
  } catch (err) {
    await failTrigger(trigger, err instanceof Error ? err.message : String(err));
  } finally {
    releaseTurnLock(projectId);
  }
}

async function failTrigger(trigger: IPmTrigger, error: string): Promise<void> {
  const exhausted = trigger.attempts >= MAX_TRIGGER_ATTEMPTS;
  await PmTrigger.findByIdAndUpdate(trigger._id, {
    $set: { state: exhausted ? "failed" : "pending", lastError: error },
  });
}

export async function drainPmTriggers(): Promise<void> {
  for (;;) {
    const claimed = await PmTrigger.findOneAndUpdate(
      { state: "pending" },
      { $set: { state: "running" }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!claimed) return;
    if (claimed.attempts > MAX_TRIGGER_ATTEMPTS) {
      await PmTrigger.findByIdAndUpdate(claimed._id, { $set: { state: "failed" } });
      continue;
    }
    await runPmTrigger(claimed);
  }
}
```

Add the imports: `runPmTurn` from `./agent`, `isOverDailyTurnCap` from `./turn-cap`, `acquireTurnLock`/`releaseTurnLock` from `./turn-lock`, `buildNeedsHumanReviewPrompt` from `./autonomy`, `IPmTrigger` from `@/types`. (`getPmUser`, `Project`, `PmTrigger` are already imported from Task 4.)

`triggeredByUserId` is the `pm` user, not `null` — that is the "separate action attribution" CP-121 asks for, and it makes the message render as PM Agent rather than as an unattributed ghost. The `trigger` field carries the *why*; `triggeredBy` carries the *who*.

No MCP plumbing is needed here. `runPmTurn` already calls `discoverMcpTools` for the project (`src/lib/pm/agent.ts:112`), so any MCP servers configured on the project — the "linked docs via MCP" from the task description — are available to autonomous turns exactly as they are in chat.

The `findOneAndUpdate` claim is what makes this safe across overlapping instances: only one process can move a document from `pending` to `running`.

- [ ] **Step 3: Try to run immediately on enqueue**

At the end of `onTaskStatusChanged`, after the `enqueuePmTrigger` call:

```typescript
  drainPmTriggers().catch((err) => console.error("PM trigger drain failed:", err));
```

The turn takes tens of seconds; the caller is already fire-and-forget, so the user's status change returns instantly. If the project's turn lock is held, `runPmTrigger` puts the trigger back to `pending` and the scheduler in Task 6 picks it up.

- [ ] **Step 4: Live check**

`npm run build`, `npm run dev`. With `OPENROUTER_API_KEY` set, PM enabled, and the needs-human-review setting on:

1. Pick a task, add a comment describing a concrete blocker ("Should this use the existing Badge component or a new one?"), then drag it to **Needs Human Review**.
2. Watch the server log; within ~a minute open `/projects/<id>/pm`.
   Expected: a new exchange in the thread — a user-role message containing the prompt, badged **"Auto review: CP-N"**, and an assistant reply with action chips.
3. Open the task. Expected: a new comment from the `pm` user that answers the question or asks exactly one question back.
4. `db.pmtriggers.find()` → the document is `state: "done"`.
5. Break it on purpose: stop the app, set `OPENROUTER_API_KEY` to garbage, restart, move another task in. Expected: the trigger ends `pending` with `lastError` set and `attempts: 1` — not lost, not looping.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pm/triggers.ts src/lib/pm/autonomy.ts
git commit -m "feat(pm): run an automatic review for needs_human_review tasks"
```

---

## Task 6: The scheduler and the daily review

**Files:**
- Create: `src/lib/pm/scheduler.ts`
- Modify: `src/lib/pm/autonomy.ts`
- Modify: `src/instrumentation.ts:1-39`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces:
  - `shouldRunDailyReview(now: Date, autonomy: IPmAutonomy): boolean`
  - `buildDailyReviewPrompt(projectKey: string): string`
  - `startPmScheduler(): void`
  - `pmSchedulerTick(): Promise<void>`

- [ ] **Step 1: Write the scheduling predicate**

Append to `src/lib/pm/autonomy.ts`:

```typescript
import { IPmAutonomy } from "@/types";

export function shouldRunDailyReview(now: Date, autonomy: IPmAutonomy | undefined): boolean {
  if (!autonomy?.dailyReview) return false;
  if (!isValidTimezone(autonomy.timezone)) return false;
  if (hourInTimezone(now, autonomy.timezone) < autonomy.reviewHour) return false;
  return autonomy.lastDailyReviewDay !== dayKeyInTimezone(now, autonomy.timezone);
}

export function buildDailyReviewPrompt(projectKey: string): string {
  return [
    `Daily board review for ${projectKey}. Nobody is waiting on a reply — this is your own pass over the board.`,
    ``,
    `Look at the board with list_tasks and get_project_stats, then report on:`,
    `- tasks stuck in the same status for a long time`,
    `- tasks in "todo" with no description or no acceptance criteria`,
    `- likely duplicates`,
    `- a pile-up in "ready_to_test" or "in_review"`,
    ``,
    `Fix what is unambiguous: fill in missing acceptance criteria, tighten vague descriptions.`,
    `Do NOT change any status and do NOT create tasks during this review.`,
    `Finish with a short summary: what you changed, and what needs rpo's attention.`,
  ].join("\n");
}
```

`>=` on the hour means a review missed because the server was down still runs later that day, and never twice. Enabling the feature after the hour has passed triggers a review within one tick — intended, since the alternative is silence until tomorrow.

- [ ] **Step 2: Logic check the predicate**

Write `<scratchpad>/review-check.js` (compile `autonomy.ts` the same way as Task 1 Step 4) and run it:

```javascript
const { shouldRunDailyReview } = require("./autonomy-compiled.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: got ${actual}, expected ${expected}`);
}

const base = { dailyReview: true, reviewHour: 9, timezone: "Europe/Warsaw", handleNeedsHumanReview: false, lastDailyReviewDay: "" };
// 08:00Z = 10:00 Warsaw (summer)
const after = new Date("2026-07-28T08:00:00Z");
// 05:00Z = 07:00 Warsaw (summer)
const before = new Date("2026-07-28T05:00:00Z");

check("disabled", shouldRunDailyReview(after, { ...base, dailyReview: false }), false);
check("undefined config", shouldRunDailyReview(after, undefined), false);
check("before the hour", shouldRunDailyReview(before, base), false);
check("after the hour, never run", shouldRunDailyReview(after, base), true);
check("already ran today", shouldRunDailyReview(after, { ...base, lastDailyReviewDay: "2026-07-28" }), false);
check("ran yesterday", shouldRunDailyReview(after, { ...base, lastDailyReviewDay: "2026-07-27" }), true);
check("catch-up late in the day", shouldRunDailyReview(new Date("2026-07-28T21:00:00Z"), base), true);
check("bad timezone", shouldRunDailyReview(after, { ...base, timezone: "Mars/Olympus" }), false);
// 22:30Z on the 28th is already the 29th in Warsaw
check("crosses midnight in tz", shouldRunDailyReview(new Date("2026-07-28T22:30:00Z"), { ...base, reviewHour: 0, lastDailyReviewDay: "2026-07-28" }), true);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

Expected: `ALL PASS`.

- [ ] **Step 3: Write the scheduler**

Create `src/lib/pm/scheduler.ts`:

```typescript
import { connectDB } from "@/lib/db";
import { Project } from "@/models/project";
import { runPmTurn } from "./agent";
import { isOverDailyTurnCap } from "./turn-cap";
import { acquireTurnLock, releaseTurnLock } from "./turn-lock";
import { drainPmTriggers } from "./triggers";
import { getPmUser } from "./pm-user";
import { buildDailyReviewPrompt, dayKeyInTimezone, shouldRunDailyReview } from "./autonomy";

const TICK_MS = 5 * 60 * 1000;

let started = false;

export function startPmScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    pmSchedulerTick().catch((err) => console.error("PM scheduler tick failed:", err));
  }, TICK_MS).unref();
}

export async function pmSchedulerTick(): Promise<void> {
  await connectDB();
  await drainPmTriggers();

  const now = new Date();
  const projects = await Project.find(
    { "pm.enabled": true, "pm.autonomy.dailyReview": true },
    "key pm"
  ).lean();
  if (projects.length === 0) return;

  const pmUser = await getPmUser();

  for (const project of projects) {
    if (!shouldRunDailyReview(now, project.pm?.autonomy)) continue;

    const dayKey = dayKeyInTimezone(now, project.pm!.autonomy!.timezone);
    const claimed = await Project.findOneAndUpdate(
      { _id: project._id, "pm.autonomy.lastDailyReviewDay": { $ne: dayKey } },
      { $set: { "pm.autonomy.lastDailyReviewDay": dayKey } }
    );
    if (!claimed) continue;

    await runDailyReview(String(project._id), project.key, project.pm!, String(pmUser._id));
  }
}

async function runDailyReview(
  projectId: string,
  projectKey: string,
  pm: { dailyTurnCap?: number },
  pmUserId: string
): Promise<void> {
  const { over, cap } = await isOverDailyTurnCap(projectId, pm);
  if (over) {
    console.warn(`PM daily review skipped for ${projectKey}: turn cap (${cap}) reached`);
    return;
  }
  if (!acquireTurnLock(projectId)) {
    console.warn(`PM daily review skipped for ${projectKey}: a turn is already running`);
    return;
  }
  try {
    const result = await runPmTurn({
      projectId,
      userMessage: buildDailyReviewPrompt(projectKey),
      triggeredByUserId: pmUserId,
      trigger: { type: "daily_review" },
    });
    if (!result.ok) console.error(`PM daily review failed for ${projectKey}:`, result.error);
  } finally {
    releaseTurnLock(projectId);
  }
}
```

The claim writes `lastDailyReviewDay` **before** the turn runs. A crash mid-review therefore costs that day's review rather than risking a restart loop that reviews forever — the safer failure direction for something that spends money on every call.

This day-claim is also what satisfies CP-121's "scheduled turns must be idempotent-ish (check last summary before re-posting)". Reading back the last summary and guessing whether it was today's is strictly weaker than an atomic claim on a day key, so the plan does the latter instead.

- [ ] **Step 4: Start it**

Use the **root** `instrumentation.ts`, not `src/instrumentation.ts`. Both files exist in this repo; Next.js resolves the root one and `src/instrumentation.ts` is dead code, so an edit there compiles, ships and silently does nothing. Inside the `if (process.env.NEXT_RUNTIME === "nodejs")` block, after the `connectDB()` log and inside the same `try`:

```typescript
      const { startPmScheduler } = await import("@/lib/pm/scheduler");
      startPmScheduler();
      console.log("PM scheduler started");
```

- [ ] **Step 5: Live check**

`npm run build`, `npm run dev`.

1. In settings enable "Daily board review" and set the review hour to the **current** hour in `Europe/Warsaw`.
2. Restart the dev server, then wait for a tick (or temporarily set `TICK_MS` to `30 * 1000` for the test — put it back before committing).
   Expected: the log prints `PM scheduler started`; within a tick a **"Scheduled review"**-badged exchange appears at `/projects/<id>/pm` with a board summary, and `db.projects.findOne().pm.autonomy.lastDailyReviewDay` equals today's Warsaw date.
3. Wait for two more ticks. Expected: **no** second review.
4. Set `lastDailyReviewDay` to `"2026-01-01"` by hand and wait a tick. Expected: exactly one new review, and the field is back to today.
5. Confirm the review changed no statuses and created no tasks (the prompt forbids both) — check the board and the action chips.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pm/scheduler.ts src/lib/pm/autonomy.ts src/instrumentation.ts
git commit -m "feat(pm): run a scheduled daily board review per project"
```

---

## Task 7: Notify humans, and document it

An auto-review that only writes into a chat thread nobody opened is not a notification.

**Files:**
- Modify: `src/lib/pm/triggers.ts`
- Modify: `CLAUDE.md`
- Create: `docs/superpowers/specs/2026-07-28-pm-phase2-autonomous-triggers.md`

**Interfaces:**
- Consumes: `createNotifications`, `collectRecipients` from `@/lib/in-app-notifications`; `runPmTrigger` (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Notify the task's watchers after an auto review**

In `runPmTrigger`, in the `result.ok` branch before updating the trigger state:

```typescript
      const task = await Task.findById(trigger.task, "title watchers assignee createdBy").lean();
      if (task) {
        createNotifications({
          type: "comment_added",
          taskId: String(trigger.task),
          projectId,
          actorId: String((await getPmUser())._id),
          title: `PM reviewed ${trigger.taskKey}`,
          body: result.message?.content?.slice(0, 120) ?? "",
          recipientIds: collectRecipients(task),
        });
      }
```

Add the imports `createNotifications`, `collectRecipients` from `@/lib/in-app-notifications` to `src/lib/pm/triggers.ts`.

`comment_added` is reused deliberately: adding a `NotificationType` means touching the enum, the model and the notifications UI, which is a separate change from this feature.

- [ ] **Step 2: Document the environment and behaviour**

In `CLAUDE.md`, under the PM environment variables, add:

```
PM_SCHEDULER_TICK_MS=     # Optional — PM scheduler tick interval (default: 300000)
```

Then honour it in `src/lib/pm/scheduler.ts`:

```typescript
const TICK_MS = Number(process.env.PM_SCHEDULER_TICK_MS) || 5 * 60 * 1000;
```

Also add a short "PM autonomy" note to `CLAUDE.md` describing that the daily review is opt-in per project, is scheduled in the project's own timezone, and that autonomous turns count against the daily turn cap.

- [ ] **Step 3: Write the design record**

Create `docs/superpowers/specs/2026-07-28-pm-phase2-autonomous-triggers.md` following the structure of the two existing specs in that directory (Status / Goal / Architecture / Data model / API / UI / Error handling / Acceptance / Out of scope). Record the four decisions a future reader will otherwise re-litigate:
1. In-process interval + atomic day-claim, not external cron (Railway single instance, no extra infra).
2. A durable trigger queue rather than firing inside the request, so a busy turn lock cannot silently drop an event.
3. Day-claim written before the turn runs — a crash costs one review instead of risking a spend loop.
4. The status hook lives on both `changeStatus` and `updateTask`, because both are real status-change paths.

Out of scope, and worth stating explicitly: multi-instance scheduling (Railway runs one), PM-initiated Slack/e-mail, and any autonomous status changes during the daily review.

- [ ] **Step 4: Live check**

Move a task into Needs Human Review as a user who is watching it. Expected: after the auto review, the bell in the navbar shows a `PM reviewed CP-N` notification linking to the task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pm/triggers.ts src/lib/pm/scheduler.ts CLAUDE.md docs/superpowers/specs/2026-07-28-pm-phase2-autonomous-triggers.md
git commit -m "feat(pm): notify watchers after an automatic review, document autonomy"
```

---

## Final acceptance (matches CP-121's checklist)

Run all of these on one branch before asking for review:

- [ ] **Plan approved by rpo before any code was written.** (This document.)
- [ ] **Daily scheduled PM review per project (opt-in), summary lands in the PM chat thread.** Task 6 Step 5.
- [ ] **`needs_human_review` tasks get an automatic PM review comment or a concrete question to rpo.** Task 5 Step 4 plus Task 7 Step 4.
- [ ] **Scheduled turns respect daily caps and guardrails; verified live.** Set `dailyTurnCap` to 1, use the one turn from chat, then force a daily review: it must be skipped with the cap warning and must not post. Then confirm a review turn still cannot create a task outside `planned` and still stops at 10 write actions.
- [ ] `npm run build` and `cd mcp-server && npm run build` both green.
- [ ] With `pm.autonomy` untouched (all defaults), the app behaves exactly as it does today: no scheduler output beyond the startup line, no triggers, no extra messages.

## Risks and open questions for rpo

1. **Cost.** Every enabled project spends one full agent turn per day plus one per `needs_human_review` transition. With `MAX_STEPS = 15` that is a real OpenRouter bill on a chatty board. `dailyTurnCap` bounds it, but the default of 100 is far above what autonomy needs — consider dropping the cap when you enable this.
2. **`vitest` or not** — see "Testing approach" above. My recommendation: add it, scoped to `src/lib/pm/autonomy.ts` only. Scheduling and timezone code is exactly where a regression is invisible until it fires at the wrong hour, and the throwaway-script approach leaves nothing behind to catch it.
3. **Prompt quality is the actual product here.** The two prompts in Tasks 5 and 6 are a first draft. Expect to iterate on them after seeing a few real reviews; that iteration is cheap and needs no code changes beyond `autonomy.ts`.
4. **The daily review deliberately cannot change statuses.** The task description allows "refines what it can", and editing text is safely reversible while a status change is not. If you want it to also advance tasks, say so at approval and I will drop that line from the prompt — but I would rather earn that trust after watching a week of reviews.
