# Project roles on a single grants collection

**Date:** 2026-08-05
**Task:** CP-246 (CP-245 ships the sidebar unblock ahead of it)
**Status:** agreed

## Problem

Project permissions live in two places and have to be kept in sync by hand:

| where | what it holds |
|---|---|
| `user.allowedProjects[]` | membership — which projects a user may open |
| `project.owner` | a single owner |
| `project.admins[]` | project administrators |

`canAdminProject()` (`src/lib/middleware.ts:52`) has to reconcile them at every call, including
the rule that a listed admin loses admin rights once their `allowedProjects` entry is revoked.
Two sources of truth for one fact produce exactly the bug reported on 2026-08-05: a user made
project admin still saw no Settings link, because the sidebar gated on the *instance* role while
the backend gated on the *project* role.

## Roles

Three levels, no more:

- **admin** — instance-wide. Creates and reorders projects, manages users, instance settings, OAuth clients.
- **owner** — full power over one board. A role, not a person: several users can own the same board.
- **member** — tasks, sprints, comments. Nothing that reshapes the board. Called "user" in
  conversation; `member` is the name in code and data, matching the existing `user.role` enum.

Owner's ceiling is everything on their own board, **including deleting it** and using the PM
agent's OAuth/MCP endpoints — both instance-admin-only today. Creating new boards stays with the
instance admin; changing that is a product decision (quotas, billing), not part of this rework.

## Permission matrix

Derived from every `route.ts` under `src/app/api` and the middleware each one wraps. The `member`
row is today's boundary transcribed exactly — this rework changes the source of truth, not who can
do what, with the two marked exceptions.

**Instance level — `admin` only, unchanged**

| capability | admin | owner | member |
|---|:--:|:--:|:--:|
| Create project, reorder projects | ✓ | — | — |
| Instance settings, users, OAuth clients | ✓ | — | — |
| Worker enrolment, commands, kill switch | ✓ | — | — |

**Board level — `owner`**

| capability | admin | owner | member |
|---|:--:|:--:|:--:|
| Edit project (name, key, integrations) | ✓ | ✓ | — |
| **Delete project** | ✓ | ✓ *(moved from admin)* | — |
| **PM agent MCP OAuth and test** | ✓ | ✓ *(moved from admin)* | — |
| Board columns | ✓ | ✓ | — |
| Webhooks, notification channels, Coda sync | ✓ | ✓ | — |
| Member list, granting and revoking roles | ✓ | ✓ | — |
| **Deleting** categories, custom fields, templates | ✓ | ✓ | — |

**Board level — `member`**

| capability | admin | owner | member |
|---|:--:|:--:|:--:|
| Tasks: create, edit, delete, status, reorder | ✓ | ✓ | ✓ |
| Comments, checklists, links, watching | ✓ | ✓ | ✓ |
| Sprints: create, edit, **delete** | ✓ | ✓ | ✓ |
| **Creating and editing** categories, custom fields, templates | ✓ | ✓ | ✓ |
| AI task generation, GitHub/GitLab sync | ✓ | ✓ | ✓ |
| Audit log, stats, PM chat | ✓ | ✓ | ✓ |

Two principals are narrowings rather than roles, and both keep their current behaviour:

| principal | reach |
|---|---|
| scoped token | its owner's rights ∩ scope, and **never owner** — a token cannot reconfigure a board |
| worker (machine credential) | `claim`, `status`, `release`, comments and heartbeat only, on projects matched by remote; no settings, no worker record |

Two inconsistencies the scan surfaced are **deliberately preserved**, not fixed here: a member can
delete a sprint but not a category, and can change a custom field's type — as destructive as
deleting it — while deletion is owner-only. Straightening those is a separate task, so the change
is visible in its own diff instead of hiding inside this refactor.

## Data model

One collection, `grants`, shaped like a Zanzibar tuple:

```
{
  subject:    ObjectId → User,
  relation:   "owner" | "member",
  objectType: "project",
  object:     ObjectId → Project,
  createdBy:  ObjectId → User,
  createdAt:  Date,
}
```

Indexes:

- `{ subject, objectType, object }` **unique** — powers `check()` and "my projects"
- `{ objectType, object }` — powers the member list on one board

One row per user–project pair, not one per relation. `owner ⊃ member` is a single hardcoded
implication inside `check()`.

### Why tuple-shaped but not ReBAC

ReBAC earns its cost by traversing a relation graph — `team → folder → document`, "editor of the
parent implies viewer of the child", groups within groups. This app has two relations on one
object type, no nesting, no sharing. A check engine with rewrite rules would be weeks of work
whose entire output is `if (relation === "owner")`.

So: take Zanzibar's **data shape** and skip its **evaluation engine**. `check()` is a plain
indexed lookup. `objectType` exists from day one so a future `team` object is new rows and one
level of expansion, not a schema migration. The cost of that optionality today is field names.

## check()

Two entry points replace `canAccessProject` / `canAdminProject`:

```
canAccessProject(principal, projectId)  // member or better
canAdminProject(principal, projectId)   // owner
```

Rules, in order — **order is load-bearing**:

1. Token carries a scope and `projectId` is outside it → **deny**.
2. `tokenScoped` → **never owner**. Tokens can read and write tasks, never reconfigure a board.
   (Preserves today's behaviour.)
3. Underlying user is an instance admin → **allow**, without consulting grants.
4. Otherwise look up the grant: `owner` satisfies both entry points, `member` satisfies access only.

### The trap in rule 3

`applyTokenScope()` (`src/lib/auth.ts:66`) downgrades `user.role` to `member` and overwrites
`user.allowedProjects` with the scope. Instance admins hold **no grant rows** — their power comes
from the role. A naive port would therefore leave an instance admin's scoped token with access to
nothing, because rule 3 sees `role === "member"` after the downgrade and rule 4 finds no grant.

The principal must keep the pre-downgrade instance-admin flag, and rule 3 must read that flag, so
a scoped token belonging to an instance admin retains member-level access to everything in its
scope. This has a dedicated regression test.

### Token scope is not a grant

`apiToken.allowedProjects`, `oauthToken.allowedProjects` and `oauthCode.allowedProjects` stay
exactly where they are. A scope *narrows* rights the bearer already holds; it never confers any.
Moving scopes into `grants` would conflate the two and let a token outlive its owner's access.

## What is removed

| before | after |
|---|---|
| `project.owner` | `project.createdBy` — informational, carries no rights |
| `project.admins[]` | gone → `owner` grants |
| `user.allowedProjects` | gone → `member` grants |
| token `allowedProjects` | unchanged |

## No migration

**There is no backfill script.** Production has five users; rpo assigns the grants by hand after
deploy (his call, 2026-08-05). Writing and testing an idempotent migration would cost more than the
migration performs.

What makes that safe rather than reckless: **instance admins hold no grants by design**, so their
access survives an empty `grants` collection. rpo is an instance admin, is therefore never locked
out, and can hand out roles through the member-management UI on each board — no Mongo shell needed.

The consequence to accept: between deploy and those clicks, every non-admin sees no projects at
all. That is `check()` failing closed, which is the right default, and at five users the window is
minutes. An empty collection means the app is waiting for grants, not broken.

## API and UI changes

- `withProjectAdmin` → `withProjectOwner` (rename follows the role).
- `DELETE /api/projects/[projectId]` and the PM agent OAuth/MCP endpoints move from `withAdmin`
  to `withProjectOwner`.
- `GET /api/projects` returns `canAdmin` per project (already shipped by CP-245).
- `/api/projects/[projectId]/members` returns members with roles and gains grant/revoke.
- `GeneralSection` replaces the admins field with a member list: role dropdown plus remove.
- `ProjectTree` gates the Settings link on `project.canAdmin`.
- `settings/users` moves per-user project assignment onto grants.

## Testing

The permission matrix is the gate:

- instance admin × owner × member × outsider × scoped token (of an admin, and of a member),
  against both `canAccessProject` and `canAdminProject`
- the rule-3 regression: an instance admin's scoped token keeps access within scope
- `tokenScoped` never satisfies `canAdminProject`
- an empty `grants` collection leaves an instance admin with full access and everyone else with
  none — the post-deploy state, which must be a clean deny rather than a crash
- granting and revoking through the member UI takes effect without a re-login
- login and API/OAuth token minting verified live in the browser — this is the surface where a
  mistake locks everyone out, and a green curl would not prove the UI path works

## Delivery

One PR, by explicit decision, with the risk understood: `allowedProjects` has 61 references
across 22 files, including token minting. CP-245 ships separately and first, because a real user
is blocked today and the sidebar fix neither depends on nor conflicts with this work.

Deploy order: merge, let Railway deploy, then rpo grants the roles through the UI. Nobody but the
instance admins can work in between, which at five users is a short and acceptable gap.
