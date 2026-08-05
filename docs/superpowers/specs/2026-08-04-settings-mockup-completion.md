# Finishing the project-settings redesign

CP-244. Mockup: `https://claude.ai/code/artifact/1ef04012-2ac4-4d69-9e3c-5d7a770c7b4b`

Branch `cp-244/settings-mockup` — `origin/main` plus the five commits `403d967..bf2bd38` that
already landed the first half.

Revised after an independent review that found four claims in the first draft understated and
two design decisions unsound. Those corrections are marked below.

## What already shipped

`SwatchPicker` and `lib/palette.ts` (twenty fixed colours), `IconPicker` (popover, search,
groups), `Switch`, `Popover`, one form that both creates and edits a custom field with all four
flags, archive/restore for fields, the integration catalogue, the AI-model field moved out of the
project, and the save-contract chip removed.

## The two faults the mockup names

**The save contract was a label, not a behaviour.** Partly fixed: the chip is gone, and General,
Board, PM and Workers register dirty groups. Task fields registers none — all nine of its handlers
fire on click. Integrations is mixed: its three dirty groups cover the vendor forms, but the
channel and webhook rows save instantly from the enabled pill and the event chips
(`IntegrationsSection.tsx:133-200,481,503,576,595`). Under this spec's own rule those are list
rows, so they are fields, so they are drafts.

**Nothing was shared, so nothing agreed.** Four of the eight kit pieces exist. The four missing
ones govern layout and destruction, so every card still invents its own geometry.

## Design

### One save rule

A control's shape says what it does. **Fields** — inputs, switches, pickers, list rows — are
drafts: marked when dirty, collected in the save bar, guarded on leave. **Actions** — buttons
carrying a verb — happen on click and report with a toast.

Removing a row from a list is a field change, not an action: it is `onChange` on the array, and it
lands in the save bar with everything else. `DangerAction` is reserved for destroying a whole
object — the project, a field — which is instant behind a confirmation, because a queued deletion
is worse than an immediate one. That keeps the two contracts from sharing a row.

**"Add admin" stays instant** — the user's decision. Worth recording that this diverges from the
mockup: its interactive shell gives the button `data-section="general"` (`mockup:656`), i.e.
treats it as a draft, and its callout (`mockup:467-473`) calls today's instant behaviour a defect.
The mockup's open-questions table then asks whether it should stay instant anyway. We are taking
the open question's side.

### The four missing components

**`SettingRow`** — the mockup's single geometry. Label and explanation at 40%, control at 60%,
stacking below 680px. It owns no state; it is a layout contract taking `label`, `hint` and
children.

**`ListEditor`** — add, reorder, edit, remove, for the four hand-rolled repeatable editors: board
columns, categories, field options, task templates. Generic over the row type: the caller supplies
`items`, a `renderRow` and `onChange` with the whole next array. It never talks to the API — the
caller's dirty group does, which is what stops the save rule leaking back out. It must keep the
keyboard reorder path today's board rows have (`BoardSection.tsx:182-197`), not just the pointer
drag.

**`DangerAction`** — confirmation, usage count, and the safer alternative where one exists.

**`SecretField`** — masked, write-only, with a Replace action.

### Escalation column — decide the reader semantics first

The per-column "PM review" checkbox is gone from the UI while `triggersPmReview` stays in the
schema, so today the flag cannot be changed at all and a new column always gets `false`.

**Correction from review.** The first draft claimed the stored shape could stay put because
"nothing server-side moves". That is wrong: there are three readers with two different rules.

| Reader | Rule |
|---|---|
| `src/lib/task-service.ts:560`, `:640` | first column with the flag **among `role === "review"`**, else `review[0]` |
| `worker/src/api.ts:70` | same rule, in a separate build |
| `src/lib/pm/triggers.ts:45-50` | the **set of every** flagged column, any role |

So the mockup's premise — "ticking it on five columns is allowed; only the first one ever gets
used" — is false for PM triggers. A select that offers any column lets someone pick a
non-`review` one: PM triggers would follow it while worker escalation silently went to
`review[0]`.

The select therefore offers **only columns whose role is `review`**, and changing that column's
role away from `review` clears the escalation with a visible warning rather than relocating it
silently. Choosing a column clears the flag on every other, which makes the three readers agree
by construction.

Projects that already have the flag on several columns need handling: the select shows one, and
the others keep `true` in Mongo until the next board save, at which point their PM triggers stop
without notice. The Board section warns when it loads such a project, naming the columns that
will lose the flag.

### Secrets — the leak is wider than the webhook URLs

**Correction from review.** The first draft named only `GET /api/projects/[projectId]`. The
actual surface:

| Route | Leaks | To |
|---|---|---|
| `api/projects/route.ts:44-55` | `gitlabToken`, `codaToken`, `notificationChannels[].webhookUrl`, `webhooks[].url` — strips only `githubToken` | every member of every visible project |
| `api/projects/[projectId]/route.ts:33-42` | both webhook URLs | every member |
| `notifications/route.ts:65,95,122`, `webhooks/route.ts:50,79,105` | full URLs in every mutation response | admin, but written straight back into client state by `patchProject` |
| `audit/route.ts:6` | full URL inside the audit text written at `webhooks/route.ts:48,102` | every member |

The token leak in the project-list route is the worse bug and the cheaper fix, so it goes first.
Tokens are plaintext when `ENCRYPTION_KEY` is unset (`lib/encryption.ts:24`).

The rule to implement is not "mask the project GET" but **no route returns a webhook URL or an
integration token to anyone who is not the owner of that secret**. Channels and webhooks get the
same treatment the three tokens already have: a `…Set` boolean plus a masked tail so a channel
stays identifiable —

```
https://hooks.slack.com/services/••••••••/••••1a2b
```

— and the audit entries record a masked value, not the URL.

### Categories become editable

There is no PATCH, so a carelessly picked name or colour is permanent for any category in use.

**Correction from review.** A rename without rewriting tasks does not orphan them quietly: task
create and update validate the category against the project's list (`task-service.ts:68-75`,
`:248-257`) and the detail editor sends `category` on every save, so a stale name makes those
tasks **fail to save with a 400**. The rewrite is mandatory, and it covers more than `Task`:

- `Task.category` across the project
- `project.taskTemplates[].category` — never validated against the list
  (`templates/route.ts:44,76`), so it would point at a dead name
- `board-filters:<projectId>` in localStorage — `lib/board-filters-state.ts:93-94` restores
  `filters.category` unvalidated, so a stale name leaves a stuck filter and an empty board. Needs
  the same treatment `sanitizeFieldFilters` already gives custom fields (`:52-64`).

Deliberately **not** rewritten, and stated so in the route: `ActivityLog`, `projectAuditLog` and
`pmMessage` are history and must keep saying what was true at the time. Already-synced Coda rows
are out of our reach.

There are no transactions anywhere in `src`, so this cannot be atomic. Order the writes
**tasks → templates → project** and make them idempotent: a crash part-way leaves tasks holding a
name that is still valid, which is a no-op, rather than a project renamed out from under them.
Reject a rename that collides case-insensitively with an existing category, as POST already does
(`categories/route.ts:38`).

`POST` and `DELETE` on categories are `withProjectAccess` today — any member. The new `PATCH`
does a project-wide bulk write and must be `withProjectAdmin`; the existing two are a separate
bug, fixed in the same commit.

### Usage counts

`/stats` returns `total` and `categoryBreakdown` — enough for delete-project and delete-category.
It has no per-custom-field count, so add `customFieldUsage` (field id → number of tasks holding a
value) via `$objectToArray` over `customFieldValues`, which is MongoDB 4.4-safe.

`DELETE /api/projects/[projectId]/custom-fields/[fieldId]` is `withProjectAccess`
(`custom-fields/[fieldId]/route.ts:69`) and unsets the value on every task with no gate and no
count — exactly what `DangerAction` is being built for. It gets the admin gate too.

## Plan

Revised ordering: the kit lands before any section is rebuilt, and each section is then rebuilt
**once** — the first draft rebuilt Task fields twice and Integrations twice.

### Phase 1 — secrets

1. `GET /api/projects` strips `gitlabToken` and `codaToken` alongside `githubToken`. One commit,
   on its own, first.
2. A masking helper plus its tests; channels and webhooks masked in the project GET, the project
   list, and every mutation response; audit text records the masked value.
3. `SecretField`; `IntegrationsSection` renders masked values with a Replace action.

### Phase 2 — the escalation column

4. Constrain the select to `review`-role columns; choosing one clears every other; changing that
   column's role away from `review` warns rather than relocating silently; a warning when a
   project loads with the flag on several columns. Tests cover the server rule — that
   `task-service.ts` and `pm/triggers.ts` resolve the same column — not only the UI.

### Phase 3 — the kit

5. `SettingRow`.
6. `ListEditor`, with the keyboard reorder path. Tests for reorder and add/remove.
7. `DangerAction`.
8. `customFieldUsage` in `/stats`; the admin gate on `DELETE /custom-fields/[fieldId]`.
9. `SaveBar.saveAll` survives a failing group instead of aborting the loop and leaving the rest
   silently unsaved (`SaveBar.tsx:33-35`) — worth doing before Phase 4 triples the group count.

### Phase 4 — rebuild each section once

Each section moves onto `SettingRow` + `ListEditor` and onto the draft contract in the same pass.

10. `PATCH /api/projects/[projectId]/categories` with the rewrite above; admin gate on POST and
    DELETE; `sanitizeCategoryFilter` in `board-filters-state.ts`. Route tests.
11. **Task fields** — categories (`SwatchPicker` replaces the last native `<input type="color">`),
    custom fields, templates: all three onto `ListEditor`, `SettingRow` and a dirty group.
12. **Integrations** — channel and webhook rows onto the draft contract; the section rebuilt on
    the kit.
13. **General, Board, PM, Workers** — rebuilt on `SettingRow`; the seven remaining bare checkboxes
    become `Switch` with inline hints (`PmAgentSection.tsx:235,354,405,532,540`,
    `WorkersSection.tsx:146,198` — note two of the five are list-row toggles and one is a generic
    boolean renderer, so they are not all drop-in); `DangerAction` on delete-project and
    delete-field with their counts.
14. Dirty markers in the nav; the save bar names every pending section rather than the first.

### Phase 5 — verification

15. `npm run build`, `npm test`.
16. Live browser pass: every section, both themes, mobile width, and a real save of each dirty
    group — including one deliberately failing save, to prove the bar recovers.

## Known gaps left open

Named so they are decisions rather than oversights.

- **Mobile.** The desktop nav search now filters correctly, but the mobile strip renders the
  unfiltered list (`page.tsx:409`) and there is no search input on mobile at all — the field
  lives inside `hidden md:block`. The mockup specifies 680px and 900px breakpoints; the code has
  one `md` (768px). Not scheduled here.
- **PM model and daily cap are still editable in two UIs** — `PmAgentSection.tsx:50-51,118-119`
  and `settings/agents/page.tsx:266-308` — with two save models. The mockup wants the project card
  to link up instead (`mockup:975-981`). Only the AI-model field actually moved.
- **The `Instance admin` chip still does double duty** (`SettingsCard.tsx:56-58`), meaning both
  "this value is global" and "only an admin may edit this" (`mockup:983-988`).
- **MCP servers stay under PM agent.** The mockup's own catalogue lists them as the seventh
  integration (`mockup:1283`) while `IntegrationCatalogue.tsx:8` has five. Its open-questions
  table asks where they belong; we are not answering it here.
- **`mcp-server/`** takes category names verbatim (`src/index.ts:64,150,195`). A rename is
  eventually consistent for MCP clients holding an old name; they get the existing 400.

## Out of scope

The mockup knows four project sections; the code has seven. Workers and Audit log arrived after
the mockup was drawn and stay.

`/settings` nav group names ("Account"/"Administration" against the mockup's "Your account"/"All
projects") are left alone — a rename with no behaviour behind it, and CP-222 revisits that copy
wholesale.
