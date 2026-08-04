# Finishing the project-settings redesign

CP-244. Mockup: `https://claude.ai/code/artifact/1ef04012-2ac4-4d69-9e3c-5d7a770c7b4b`

Branch `cp-244/settings-mockup` — `origin/main` plus the five commits `403d967..bf2bd38` that
already landed the first half.

## What already shipped

`SwatchPicker` and `lib/palette.ts` (twenty fixed colours), `IconPicker` (popover, search,
groups), `Switch`, `Popover`, one form that both creates and edits a custom field with all four
flags, archive/restore for fields, the integration catalogue, instance settings moved out of the
project, and the save-contract chip removed.

## The two faults the mockup names

**The save contract was a label, not a behaviour.** Half of it is fixed: the chip is gone and
General, Board, Integrations, PM and Workers are drafts collected in the save bar. Task fields is
not — categories, custom fields and templates each fire their own request on click, which is the
same mismatch in a new place.

**Nothing was shared, so nothing agreed.** Five of the eight kit pieces exist. The three missing
ones are the ones that govern layout, so every card still invents its own geometry.

## Design

### One save rule

A control's shape says what it does. **Fields** — inputs, switches, pickers, list rows — are
drafts: marked when dirty, collected in the save bar, guarded on leave. **Actions** — buttons
carrying a verb — happen on click and report with a toast.

Two exceptions, both deliberate:

- **"Add admin" stays instant.** It is the one action people reasonably expect to be immediate,
  and the mockup lists it as an open question rather than a defect.
- **Delete stays instant**, behind `DangerAction`'s confirmation. A queued deletion is worse than
  an immediate one.

### The three missing components

**`SettingRow`** — the mockup's single geometry. Label and explanation at 40%, control at 60%,
stacking below 680px. It owns no state; it is a layout contract, so it takes `label`,
`hint` and children.

**`ListEditor`** — add, reorder, edit, remove, for the four hand-rolled repeatable editors: board
columns, categories, field options, task templates. Generic over the row type: the caller supplies
`items`, a `renderRow`, and `onChange` with the whole next array. Reordering and the add/remove
buttons live in the component; what a row contains does not. It never talks to the API — the
caller's dirty group does, which is what keeps the save rule from leaking back out.

**`DangerAction`** — the confirmation, plus a usage count, plus (where one exists) the safer
alternative. Delete project quotes its task count; delete field quotes how many tasks hold a
value and offers Archive instead.

**`SecretField`** — masked, write-only, with a Replace action, for anything that grants access.

### Escalation column

The per-column "PM review" checkbox is gone from the UI, but `triggersPmReview` is still in the
schema, still read by `task-service.ts:560` and `:640`, and still carried through the column
draft — so today the flag cannot be changed at all. A new column always gets `false`.

Replace it with one select in a "Hand-off to the PM agent" card: the single column that means a
human or the PM agent needs to look at this. Choosing one clears the flag on every other column,
which retires the "tick it on five, only the first is used" ambiguity. The hint names both
effects — a failed or timed-out worker run moves the task here, and arriving here queues a PM turn
against the daily cap — because today's tooltip describes only one of them.

The stored shape does not change: `triggersPmReview` stays a per-column boolean, so nothing
server-side moves. The select is a view over it with an enforced single writer.

### Webhook URLs are credentials

`IntegrationsSection.tsx:497` prints `ch.webhookUrl` in full, and `GET /api/projects/[projectId]`
— which is `withProjectAccess`, so any member — returns it. That route already strips
`githubToken`, `gitlabToken` and `codaToken` and exposes `…Set` booleans in their place. Webhook
URLs get the same treatment, keeping a masked tail so a channel stays identifiable:

```
https://hooks.slack.com/services/••••••••/••••1a2b
```

Replacing one posts a new URL; nothing ever reads the old one back to the client.

### Categories become editable

There is no PATCH for categories, so a carelessly picked name or colour is permanent for any
category already in use. Add `PATCH /api/projects/[projectId]/categories`. Renaming has to carry:
tasks store the category by name, so the patch renames it across the project's tasks in the same
request, or it is a rename that silently orphans them.

### Usage counts

`/stats` already returns `total` and `categoryBreakdown` — enough for delete-project and
delete-category. It has no per-custom-field count, so add `customFieldUsage` (field id → number of
tasks holding a value) via `$objectToArray` over `customFieldValues`, which is 4.4-safe.

## Plan

Each phase builds, tests and stands on its own.

### Phase 1 — the two defects

1. `SecretField`; strip `notificationChannels[].webhookUrl` and `webhooks[].url` from the project
   GET, exposing a masked tail; `IntegrationsSection` renders the masked value and a Replace
   action. Tests for the masking helper.
2. "Hand-off to the PM agent" card in `BoardSection`: one select, single-writer semantics, both
   effects named in the hint. Test that choosing a column clears every other.

### Phase 2 — the kit

3. `SettingRow` — component plus the two-column/stacked geometry.
4. `ListEditor` — generic rows, reorder, add, remove. Tests for the reorder and add/remove logic.
5. `DangerAction` — confirm, usage count, alternative action.
6. `customFieldUsage` in `/stats`.

### Phase 3 — one save rule in Task fields

7. `PATCH /api/projects/[projectId]/categories`, renaming across tasks. Route test.
8. Categories: `SwatchPicker`, `ListEditor`, and a dirty group. The native `<input type="color">`
   goes — the last of the three OS dialogs.
9. Custom fields and task templates onto the same contract.

### Phase 4 — geometry and polish

10. Every section rebuilt on `SettingRow`.
11. The six remaining bare checkboxes become `Switch` with inline hints —
    `PmAgentSection` (5) and `WorkersSection` (2).
12. Dirty markers in the nav; the save bar names every pending section rather than the first.
13. `DangerAction` wired into delete-project and delete-field with their counts.

### Phase 5 — verification

14. `npm run build`, `npm test`.
15. Live pass in the browser: every section, both themes, mobile width, and a real save of each
    dirty group.

## Out of scope

The mockup knows four project sections; the code has seven. Workers and Audit log arrived after
the mockup was drawn and stay where they are.

`/settings` nav group names ("Account"/"Administration" against the mockup's "Your account"/"All
projects") are left alone — a rename with no behaviour behind it, and CP-222 is going to revisit
that copy wholesale.
