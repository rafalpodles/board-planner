# Project Roles on a Grants Collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `user.allowedProjects[]` + `project.owner` + `project.admins[]` with one `grants` collection and three roles — instance `admin`, project `owner`, project `member`.

**Architecture:** A tuple-shaped `grants` collection (`{subject, relation, objectType, object}`) is the single source of truth. Authorisation splits into a **pure decision function** over a principal and at most one grant row, and a **thin lookup** that fetches that row. No graph traversal, no rewrite rules — `owner ⊃ member` is one hardcoded implication.

**Tech Stack:** Next.js 16 App Router, TypeScript, Mongoose, Vitest, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-05-project-roles-grants-design.md`
**Task:** CP-246. **Branch:** `cp-246/project-roles-grants`.

*Revision 2, after an independent review. Findings that changed the plan are marked **[review]** at the point they apply, so an implementer can see which steps exist because something was nearly missed.*

## Global Constraints

- **No backfill script.** rpo assigns grants by hand after deploy. An empty `grants` collection must leave instance admins working and everyone else cleanly denied — never crash.
- **Exactly three capability changes are permitted**, and no others. Anything else changing who can do what is a bug in this plan:
  1. Deleting a project moves from instance admin to owner.
  2. The PM agent MCP OAuth/test endpoints move from instance admin to owner.
  3. **[review]** `GET /api/projects/:id/members` returns every human account rather than only the project's current members. You cannot grant access to somebody you cannot see. This is a real widening of who is visible to a project owner and is recorded as such in the spec's matrix.
- Sprint deletion and custom-field editing stay with `member` even though they are inconsistent — that is CP-247.
- **Token scope fields stay put.** `apiToken.allowedProjects`, `oauthToken.allowedProjects`, `oauthCode.allowedProjects` are scopes, not grants. Do not touch them.
- **Instance admins hold no grant rows.** Their access comes from `role === "admin"`. Never write grants for them.
- **No commit may leave authorization wider than it is today.** Narrower for a commit or two is acceptable; wider is a defect. Task 3 exists as one commit for exactly this reason.
- MongoDB 4.4: no `$dateTrunc`, `$dateAdd`/`$dateDiff`, `$setWindowFields`, and no `$lookup` mixing `localField`/`foreignField` with an inline `pipeline`.
- Comments: default to none. Only a one-liner for a genuinely non-obvious workaround.
- Code, commits and PR text in English. Conventional commits. No `Co-Authored-By`, no generated-with footer.
- Every commit must leave `npx vitest run` green.

## Scale, measured

`grep -rn "allowedProjects" src` → **73 hits across 27 files** (not the 61/22 quoted in revision 1 and in the spec; that count omitted test fixtures). Of those, the ones that are *token scope* and must survive untouched live in `src/app/(app)/settings/tokens/page.tsx`, `src/app/api/oauth/connections/route.ts`, `src/app/oauth/token/route.ts`, `src/app/api/tokens/route.ts`, `src/models/apiToken.ts`, `src/models/oauthToken.ts`, `src/models/oauthCode.ts`, `src/lib/auth.ts:101,121` and the token-scope entries in `src/types/index.ts`.

---

## Task 0: Land CP-245 first and rebase

**[review]** Revision 1 assumed CP-245's changes were on this branch. They are not: `git merge-base --is-ancestor d4a0783 HEAD` returns false. `cp-246/project-roles-grants` branched from `8e954d1` and carries only documentation commits. Everything below depends on `GET /api/projects` returning `canAdmin` and on `ProjectTree` gating the Settings link on it — neither of which exists here.

- [ ] **Step 1: Confirm CP-245 is merged**

Run: `git fetch origin && git log --oneline origin/main | head -5`
Expected: a merge commit for PR #99. If it is not there, stop — rpo merges it, since `gh pr merge` is not available to an agent.

- [ ] **Step 2: Rebase**

```bash
git rebase origin/main
```

- [ ] **Step 3: Confirm the two prerequisites now exist**

Run: `grep -n "canAdmin" src/app/api/projects/route.ts src/components/shell/ProjectTree.tsx`
Expected: `obj.canAdmin = canAdminProject(user, p);` in the API route and `{(project.canAdmin ?? isAdmin) && (` in `ProjectTree.tsx`. If either is missing the rebase did not take, and Tasks 3 and 9 will not work as written.

---

### Task 1: Grant model and the pure decision function

**Files:**
- Create: `src/models/grant.ts`, `src/lib/grants.ts`, `src/lib/grants.test.ts`
- Modify: `src/types/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GrantRelation = "owner" | "member"`, `type Need = "access" | "admin"`
  - `interface Principal { instanceAdmin: boolean; tokenScoped: boolean; tokenScope: string[] | null; instanceAdminBeforeScope: boolean }`
  - `function decide(principal: Principal, grant: GrantRelation | null, need: Need, projectId: string): boolean`
  - `function principalOf(user: IUser): Principal`
  - `const Grant: Model<IGrant>`

- [ ] **Step 1: Add the types**

In `src/types/index.ts`, beside the other model interfaces:

```ts
export const GRANT_RELATIONS = ["owner", "member"] as const;
export type GrantRelation = (typeof GRANT_RELATIONS)[number];

export interface IGrant {
  _id: Types.ObjectId;
  subject: Types.ObjectId;
  relation: GrantRelation;
  objectType: "project";
  object: Types.ObjectId;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}
```

In `interface IUser`, directly below the existing `tokenScoped` field (`src/types/index.ts:156`):

```ts
  // Runtime-only, set for project-scoped tokens — the projects the token narrowed to
  tokenScope?: Types.ObjectId[];
  // Runtime-only. An instance admin's role is downgraded to member by applyTokenScope, and
  // instance admins hold no grants — without this their scoped tokens would resolve to no access.
  instanceAdminBeforeScope?: boolean;
```

- [ ] **Step 2: Write the failing matrix test**

Create `src/lib/grants.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decide, Principal } from "./grants";

const P = "69a52e3b399b27d3cbb2c5a5";
const OTHER = "69a52e3b399b27d3cbb2c5a6";

function principal(over: Partial<Principal> = {}): Principal {
  return {
    instanceAdmin: false,
    tokenScoped: false,
    tokenScope: null,
    instanceAdminBeforeScope: false,
    ...over,
  };
}

describe("decide", () => {
  it("gives an instance admin both access and admin without any grant", () => {
    const p = principal({ instanceAdmin: true });
    expect(decide(p, null, "access", P)).toBe(true);
    expect(decide(p, null, "admin", P)).toBe(true);
  });

  it("gives an owner both access and admin", () => {
    const p = principal();
    expect(decide(p, "owner", "access", P)).toBe(true);
    expect(decide(p, "owner", "admin", P)).toBe(true);
  });

  it("gives a member access but never admin", () => {
    const p = principal();
    expect(decide(p, "member", "access", P)).toBe(true);
    expect(decide(p, "member", "admin", P)).toBe(false);
  });

  it("refuses someone with no grant at all", () => {
    const p = principal();
    expect(decide(p, null, "access", P)).toBe(false);
    expect(decide(p, null, "admin", P)).toBe(false);
  });

  it("refuses a project outside a token's scope even to an owner", () => {
    const p = principal({ tokenScoped: true, tokenScope: [OTHER] });
    expect(decide(p, "owner", "access", P)).toBe(false);
  });

  it("never lets a scoped token administer, even as owner in scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [P] });
    expect(decide(p, "owner", "admin", P)).toBe(false);
    expect(decide(p, "owner", "access", P)).toBe(true);
  });

  // An UNSCOPED token leaves tokenScoped false, so its bearer keeps admin rights via their grant.
  // This is today's behaviour at middleware.ts:96 and must not tighten.
  it("lets an unscoped token administer a board its bearer owns", () => {
    const p = principal({ tokenScoped: false, tokenScope: null });
    expect(decide(p, "owner", "admin", P)).toBe(true);
  });

  // The regression the spec is built around: applyTokenScope downgrades an instance admin to
  // member, and instance admins hold no grant rows, so a naive lookup strips all their access.
  it("keeps an instance admin's scoped token working inside its scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [P], instanceAdminBeforeScope: true });
    expect(decide(p, null, "access", P)).toBe(true);
    expect(decide(p, null, "admin", P)).toBe(false);
  });

  it("still confines an instance admin's scoped token to its scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [OTHER], instanceAdminBeforeScope: true });
    expect(decide(p, null, "access", P)).toBe(false);
  });
});
```

**[review]** Revision 1's last test passed the helper's own defaults and was therefore a duplicate of the first. It is replaced above by the unscoped-token case, which is a genuinely distinct principal and encodes a rule that must not tighten.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run src/lib/grants.test.ts`
Expected: FAIL — `Failed to resolve import "./grants"`.

- [ ] **Step 4: Write the model**

Create `src/models/grant.ts`:

```ts
import mongoose, { Schema, Model } from "mongoose";
import { IGrant, GRANT_RELATIONS } from "@/types";

const grantSchema = new Schema<IGrant>(
  {
    subject: { type: Schema.Types.ObjectId, ref: "User", required: true },
    relation: { type: String, enum: GRANT_RELATIONS, required: true },
    objectType: { type: String, enum: ["project"], required: true, default: "project" },
    object: { type: Schema.Types.ObjectId, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

grantSchema.index({ subject: 1, objectType: 1, object: 1 }, { unique: true });
grantSchema.index({ objectType: 1, object: 1 });

export const Grant: Model<IGrant> =
  mongoose.models.Grant || mongoose.model<IGrant>("Grant", grantSchema);
```

- [ ] **Step 5: Write the decision function**

Create `src/lib/grants.ts`:

```ts
import { IUser, GrantRelation } from "@/types";

export type Need = "access" | "admin";

export interface Principal {
  instanceAdmin: boolean;
  tokenScoped: boolean;
  tokenScope: string[] | null;
  instanceAdminBeforeScope: boolean;
}

export function decide(
  principal: Principal,
  grant: GrantRelation | null,
  need: Need,
  projectId: string
): boolean {
  if (principal.tokenScope && !principal.tokenScope.includes(projectId)) return false;
  if (need === "admin" && principal.tokenScoped) return false;
  if (principal.instanceAdmin || principal.instanceAdminBeforeScope) return true;
  if (grant === "owner") return true;
  return grant === "member" && need === "access";
}

export function principalOf(user: IUser): Principal {
  return {
    instanceAdmin: user.role === "admin",
    tokenScoped: !!user.tokenScoped,
    tokenScope: user.tokenScope ? user.tokenScope.map(String) : null,
    instanceAdminBeforeScope: !!user.instanceAdminBeforeScope,
  };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/grants.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add src/models/grant.ts src/lib/grants.ts src/lib/grants.test.ts src/types/index.ts
git commit -m "feat(auth): add the grants model and the permission decision function"
```

---

### Task 2: check(), accessibleProjectIds() and the token-scope principal

**Files:**
- Modify: `src/lib/grants.ts`, `src/lib/grants.test.ts`, `src/lib/auth.ts:66-77`

**Interfaces:**
- Produces: `check(user, projectId, need): Promise<boolean>`; `accessibleProjectIds(user): Promise<string[] | null>` where `null` means "no restriction" (unscoped instance admin).

**Do NOT remove `user.allowedProjects = effective` from `applyTokenScope` in this task.** Two places still read that field until Task 3 — `withProjectAccess` and, less obviously, the hand-rolled check in `pm/chat`. Dropping the narrowing here would widen every scoped token's reach for one commit.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/grants.test.ts` (and add `vi`, `beforeEach` to the vitest import at the top):

```ts
const findOne = vi.fn();
const find = vi.fn();
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/grant", () => ({
  Grant: {
    findOne: (...args: unknown[]) => findOne(...args),
    find: (...args: unknown[]) => find(...args),
  },
}));

const { check, accessibleProjectIds } = await import("./grants");

function lean(value: unknown) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

describe("check", () => {
  beforeEach(() => {
    findOne.mockReset();
    find.mockReset();
  });

  it("reads the grant for an ordinary user", async () => {
    findOne.mockReturnValue(lean({ relation: "owner" }));
    const user = { _id: "u1", role: "member" } as never;
    expect(await check(user, P, "admin")).toBe(true);
    expect(findOne).toHaveBeenCalledWith({ subject: "u1", objectType: "project", object: P });
  });

  it("denies cleanly when the collection is empty", async () => {
    findOne.mockReturnValue(lean(null));
    const user = { _id: "u1", role: "member" } as never;
    expect(await check(user, P, "access")).toBe(false);
  });

  it("answers for an instance admin without querying at all", async () => {
    const user = { _id: "a1", role: "admin" } as never;
    expect(await check(user, P, "admin")).toBe(true);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("answers out-of-scope tokens without querying at all", async () => {
    const user = { _id: "u1", role: "member", tokenScoped: true, tokenScope: [OTHER] } as never;
    expect(await check(user, P, "access")).toBe(false);
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("accessibleProjectIds", () => {
  beforeEach(() => {
    findOne.mockReset();
    find.mockReset();
  });

  it("returns null for an unscoped instance admin", async () => {
    const user = { _id: "a1", role: "admin" } as never;
    expect(await accessibleProjectIds(user)).toBe(null);
  });

  it("returns the scope for an instance admin's scoped token", async () => {
    const user = {
      _id: "a1",
      role: "member",
      tokenScoped: true,
      tokenScope: [P],
      instanceAdminBeforeScope: true,
    } as never;
    expect(await accessibleProjectIds(user)).toEqual([P]);
  });

  it("returns the granted projects for an ordinary user", async () => {
    find.mockReturnValue(lean([{ object: P }, { object: OTHER }]));
    const user = { _id: "u1", role: "member" } as never;
    expect(await accessibleProjectIds(user)).toEqual([P, OTHER]);
  });

  it("intersects grants with a token scope", async () => {
    find.mockReturnValue(lean([{ object: P }, { object: OTHER }]));
    const user = { _id: "u1", role: "member", tokenScoped: true, tokenScope: [OTHER] } as never;
    expect(await accessibleProjectIds(user)).toEqual([OTHER]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/lib/grants.test.ts`
Expected: FAIL — `check is not a function`.

- [ ] **Step 3: Implement both functions**

Append to `src/lib/grants.ts`, adding imports of `connectDB` from `./db` and `Grant` from `@/models/grant`:

```ts
export async function check(user: IUser, projectId: string, need: Need): Promise<boolean> {
  const principal = principalOf(user);
  // The query is skipped where no grant can change the verdict; the verdict itself always
  // comes from decide(), so the rule ordering lives in exactly one place.
  const withoutGrant =
    principal.instanceAdmin ||
    principal.instanceAdminBeforeScope ||
    (principal.tokenScope !== null && !principal.tokenScope.includes(projectId));
  if (withoutGrant) return decide(principal, null, need, projectId);

  await connectDB();
  const grant = await Grant.findOne({
    subject: user._id,
    objectType: "project",
    object: projectId,
  })
    .select("relation")
    .lean();

  return decide(principal, grant?.relation ?? null, need, projectId);
}

export async function accessibleProjectIds(user: IUser): Promise<string[] | null> {
  const principal = principalOf(user);
  if (principal.instanceAdmin || principal.instanceAdminBeforeScope) {
    return principal.tokenScope;
  }

  await connectDB();
  const grants = await Grant.find({ subject: user._id, objectType: "project" })
    .select("object")
    .lean();

  const ids = grants.map((g) => String(g.object));
  return principal.tokenScope ? ids.filter((id) => principal.tokenScope!.includes(id)) : ids;
}
```

**[review]** `check()` must not re-implement rule 1. Revision 1 had the scope test inline *and* inside `decide()`, so a future edit to the rule ordering would silently diverge from the tested function. The shape above keeps the query optimisation without duplicating policy.

- [ ] **Step 4: Record the scope on the principal in auth.ts**

Replace `applyTokenScope` (`src/lib/auth.ts:66-77`) with:

```ts
function applyTokenScope(user: IUser, scope: Types.ObjectId[]): IUser {
  user.instanceAdminBeforeScope = user.role === "admin";
  user.role = "member";
  user.tokenScope = scope;
  user.allowedProjects = user.instanceAdminBeforeScope
    ? scope
    : (user.allowedProjects || []).filter((p) =>
        scope.some((s) => s.toString() === p.toString())
      );
  user.tokenScoped = true;
  return user;
}
```

Keep the existing comment above the function. The `allowedProjects` narrowing is deliberately unchanged and goes away in Task 3.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. `grants.test.ts` now holds **17** tests (9 from Task 1, 8 added here).

- [ ] **Step 6: Commit**

```bash
git add src/lib/grants.ts src/lib/grants.test.ts src/lib/auth.ts
git commit -m "feat(auth): resolve grants and carry token scope on the principal"
```

---

### Task 3: Every reader switches to grants, in one commit

The single commit where the source of truth changes. It must move **every** reader at once — a reader left on `allowedProjects` after the narrowing is dropped is a widened permission.

**[review]** Revision 1 moved the middleware but missed three readers: the hand-rolled check in `pm/chat`, the two `canAdminProject` call sites in `[projectId]/route.ts`, and `/api/auth/me`. The first is a security defect, the second silently blanks the settings UI for everyone, the third leaks an un-narrowed scope.

**Files:**
- Modify: `src/lib/middleware.ts` — delete `refId` and `canAdminProject` (lines 86-104), rewrite both middlewares, rename `withProjectAdmin` → `withProjectOwner`
- Modify: `src/lib/auth.ts` — drop the `allowedProjects` narrowing
- Modify: `src/app/api/projects/[projectId]/pm/chat/route.ts:46-50`
- Modify: `src/app/api/projects/[projectId]/route.ts:4, :44, :240`
- Modify: `src/app/api/auth/me/route.ts:27`
- Modify: `src/app/api/projects/route.ts` (filter and `canAdmin`), `src/app/api/search/route.ts:27`, `src/app/api/tasks/mine/route.ts:14`
- Modify: the nine files carrying `withProjectAdmin`

- [ ] **Step 1: Rewrite the two middlewares**

In `src/lib/middleware.ts` delete `refId` and `canAdminProject` entirely, add `import { check, accessibleProjectIds } from "./grants";`, and replace both bodies:

```ts
export function withProjectOwner(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(params.projectId) : null;
    if (!projectId) {
      return unresolvedProject(user);
    }

    if (!(await check(user, projectId, "admin"))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const resolved = await withResolvedIds(context, params, projectId);
    if (!resolved.ok) return resolved.response;
    return handler(request, resolved.context);
  });
}

export function withProjectAccess(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(params.projectId) : null;
    if (!projectId) {
      return unresolvedProject(user);
    }

    if (!(await check(user, projectId, "access"))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const resolved = await withResolvedIds(context, params, projectId);
    if (!resolved.ok) return resolved.response;
    return handler(request, resolved.context);
  });
}
```

`withProjectAccessOrWorker` (`middleware.ts:216-259`) needs no change — its worker branch builds the identity itself and never consults membership, and its person branch calls the rewritten `withProjectAccess`. Task 3 Step 7 proves that rather than assuming it.

Behaviour change to expect: for a non-admin, a project that does not exist now returns 403 rather than 404, because the grant lookup fails before any project lookup. That matches `unresolvedProject`'s existing policy of not leaking which projects exist.

- [ ] **Step 2: Fix the hand-rolled check in pm/chat**

**[review]** `src/app/api/projects/[projectId]/pm/chat/route.ts` authenticates by hand because it streams SSE, and says so at line 39. Its gate at lines 46-50 reads `user.allowedProjects` directly. Replace:

```ts
  if (
    user.role !== "admin" &&
    !(user.allowedProjects || []).some((p) => p.toString() === projectId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
```

with:

```ts
  if (!(await check(user, projectId, "access"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
```

importing `check` from `@/lib/grants`.

- [ ] **Step 3: Replace both canAdminProject call sites**

**[review]** `src/app/api/projects/[projectId]/route.ts:44` (inside `GET`, wrapped in `withProjectAccessOrWorker`) and `:240` (inside `PUT`). Both become:

```ts
  obj.canAdmin = await check(user, String(project._id), "admin");
```

Do **not** simply delete these lines to make the build pass. `project.canAdmin` gates every project-admin section of the settings page (`src/app/(app)/projects/[projectId]/settings/page.tsx:202` and `:367`, plus `TaskFieldsSection.tsx:44`); an `undefined` there hides the member-management UI from everybody including instance admins, and with no backfill that leaves no way to create the first grant at all.

On the `GET` path `user` may be a worker identity, which holds no grant and so gets `false` — the same answer it gets today.

- [ ] **Step 4: Drop the allowedProjects narrowing**

`applyTokenScope` in `src/lib/auth.ts` becomes:

```ts
function applyTokenScope(user: IUser, scope: Types.ObjectId[]): IUser {
  user.instanceAdminBeforeScope = user.role === "admin";
  user.role = "member";
  user.tokenScope = scope;
  user.tokenScoped = true;
  return user;
}
```

- [ ] **Step 5: Move the four list queries onto grants**

`src/app/api/projects/route.ts` — replace the `filter` derivation:

```ts
  const ids = await accessibleProjectIds(user);
  const filter = ids === null ? {} : { _id: { $in: ids } };
```

and, because `canAdmin` now needs `await`, change the `map` to `const sanitized = await Promise.all(projects.map(async (p) => { … }));` with:

```ts
    obj.canAdmin = await check(user, String(p._id), "admin");
```

`src/app/api/search/route.ts:27` and `src/app/api/tasks/mine/route.ts:14` — replace `const allowed = user.allowedProjects || [];` with:

```ts
  const allowed = (await accessibleProjectIds(user)) ?? [];
```

Leave the surrounding `user.role === "admin"` branch alone in both.

**[review]** `src/app/api/auth/me/route.ts:27` must move in this commit too, not in Task 8 — from Task 3 onward `user.allowedProjects` is the raw stored array, so leaving it here reports an un-narrowed scope to a scoped session. Replace `allowedProjects: user.allowedProjects || []` with:

```ts
    allowedProjects: (await accessibleProjectIds(user)) ?? [],
```

and note the known wart: an unscoped instance admin gets `[]` from that `??`. Task 8 Step 6 removes the key entirely, which is the real fix; nothing reads it in the meantime (verified: the only `allowedProjects` readers under `src/app` and `src/components` are the users page, which Task 7 changes, and the tokens page, which reads token scopes).

- [ ] **Step 6: Rename every withProjectAdmin call site**

There are **nine** files, not seven:

`projects/[projectId]/route.ts`, `templates/route.ts`, `members/route.ts`, `columns/route.ts`, `custom-fields/[fieldId]/route.ts`, `webhooks/route.ts`, `categories/route.ts`, `coda/sync/route.ts`, `notifications/route.ts` — plus `src/lib/middleware.ts` itself.

```bash
grep -rl "withProjectAdmin" src | xargs sed -i '' 's/withProjectAdmin/withProjectOwner/g'
```

**[review]** That `grep -rl` also matches `src/app/api/workers/[workerId]/route.ts`, where `withProjectAdmin` appears only inside a prose comment. Read the resulting diff on that file and reword the comment rather than leaving a renamed reference to a middleware it never used.

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, including `src/lib/middleware.worker-credential.test.ts` — that file is the evidence for the "worker path needs no change" claim in Step 1.

**[review]** Four fixtures express "project admin" as `allowedProjects: [...]` and will keep passing while no longer meaning anything: `src/app/api/workers/[workerId]/route.test.ts:35-47`, `command/route.test.ts:18-19`, `enrolment/route.test.ts:15-22`, `admin/workers/route.test.ts:17-18`. Re-express each — a project owner is now a user with an `owner` grant, so the fixture should mock `@/lib/grants`'s `check` — and fix the now-false comments above them. Do this even though the tests are green; a fixture that no longer expresses its intent is a test that has stopped testing.

- [ ] **Step 8: Prove no reader was left behind**

Run: `grep -rn "allowedProjects" src --include="*.ts" --include="*.tsx" | grep -v "apiToken\|oauthToken\|oauthCode\|tokens/page\|tokens/route\|oauth/\|types/index"`
Expected: only `src/lib/auth.ts:101,121` (reading token scope off the token record) and `src/lib/worker-user.ts:45` and `src/lib/pm/pm-user.ts:26` (both writing `[]` into a user document, removed in Task 8). Anything else is a reader this task missed.

- [ ] **Step 9: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(auth): authorise from grants instead of allowedProjects and admins[]"
```

---

### Task 4: Move project delete and the PM agent endpoints to the owner

**Files:**
- Modify: `src/app/api/projects/[projectId]/route.ts:244` — `withAdmin` → `withProjectOwner`
- Modify: `pm/mcp-test/route.ts:9`, `pm/mcp-oauth/start/route.ts:18`, `pm/mcp-oauth/disconnect/route.ts:6`

- [ ] **Step 1: Swap the middleware in all four routes**

In each file change the import from `withAdmin` to `withProjectOwner` and the wrapper on the listed export. `DELETE` becomes:

```ts
export const DELETE = withProjectOwner(async (_request, { params }) => {
```

- [ ] **Step 2: Note the half that deliberately does not move**

**[review]** `pm.mcpServers` stays in `instanceFields` at `src/app/api/projects/[projectId]/route.ts:141`, so after this task an owner can run OAuth against and disconnect MCP servers they cannot add or configure. That is intentional — configuring which servers exist is an instance concern — but it must be written into the spec's matrix as a footnote, otherwise it reads as an oversight. Add that footnote now.

- [ ] **Step 3: Confirm nothing else in those files needed withAdmin**

Run: `grep -rn "withAdmin" "src/app/api/projects/[projectId]/route.ts" src/app/api/projects/*/pm/`
Expected: no output.

- [ ] **Step 4: Run the suite and build**

Run: `npx vitest run && npm run build`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(auth): let a project owner delete the board and run its PM agent OAuth"
```

---

### Task 5: Members API on grants

**Files:**
- Modify: `src/app/api/projects/[projectId]/members/route.ts`
- Create: `src/app/api/projects/[projectId]/members/route.test.ts`
- Modify: `src/types/index.ts` — `ApiProjectMember`

**Interfaces:**
- `GET` → `{ _id, username, fullName, relation: "owner" | "member" | null, instanceAdmin: boolean }[]`
- `PUT { userId, relation }` → upserts one grant
- `DELETE ?userId=…` → removes the grant

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/projects/[projectId]/members/route.test.ts`. Note that every mock is a `vi.fn()` so the query filters themselves are assertable — a members endpoint whose filters are unobservable is not tested.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const grantFind = vi.fn();
const grantFindLean = vi.fn();
const grantUpdateOne = vi.fn();
const grantDeleteOne = vi.fn();
const grantCountDocuments = vi.fn();
const userFind = vi.fn();
const userFindLean = vi.fn();
const userFindById = vi.fn();
const check = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check, accessibleProjectIds: vi.fn() };
});
vi.mock("@/models/grant", () => ({
  Grant: {
    find: (...a: unknown[]) => (grantFind(...a), { select: () => ({ lean: grantFindLean }) }),
    updateOne: grantUpdateOne,
    deleteOne: grantDeleteOne,
    countDocuments: grantCountDocuments,
  },
}));
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) => (userFind(...a), { select: () => ({ sort: () => ({ lean: userFindLean }) }) }),
    findById: (...a: unknown[]) => (userFindById(...a), { select: () => Promise.resolve({ _id: "u1", role: "member", kind: "human" }) }),
  },
}));
vi.mock("@/models/project", () => ({ Project: { findOne: vi.fn() } }));
vi.mock("@/models/task", () => ({ Task: {} }));

const { GET, PUT, DELETE } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });

function put(body: unknown) {
  return new Request(`http://x/api/projects/${PROJECT}/members`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "o1", role: "member" });
  check.mockResolvedValue(true);
  grantFindLean.mockResolvedValue([]);
  userFindLean.mockResolvedValue([]);
  grantCountDocuments.mockResolvedValue(2);
});

describe("GET members", () => {
  it("labels each user with their relation on this project", async () => {
    userFindLean.mockResolvedValue([
      { _id: "u1", username: "ann", fullName: "Ann", role: "member" },
      { _id: "u2", username: "bo", fullName: "Bo", role: "member" },
    ]);
    grantFindLean.mockResolvedValue([{ subject: "u1", relation: "owner" }]);

    const body = await (await GET(new Request("http://x"), { params })).json();

    expect(body).toEqual([
      { _id: "u1", username: "ann", fullName: "Ann", relation: "owner", instanceAdmin: false },
      { _id: "u2", username: "bo", fullName: "Bo", relation: null, instanceAdmin: false },
    ]);
  });

  it("scopes the grant query to this project", async () => {
    await GET(new Request("http://x"), { params });
    expect(grantFind).toHaveBeenCalledWith({ objectType: "project", object: PROJECT });
  });

  it("never offers worker machine identities as grantable members", async () => {
    await GET(new Request("http://x"), { params });
    expect(userFind).toHaveBeenCalledWith({ kind: { $ne: "machine" } });
  });

  it("marks instance admins, who hold no grants", async () => {
    userFindLean.mockResolvedValue([{ _id: "a1", username: "root", fullName: "Root", role: "admin" }]);
    const body = await (await GET(new Request("http://x"), { params })).json();
    expect(body[0]).toMatchObject({ relation: null, instanceAdmin: true });
  });
});

describe("PUT members", () => {
  it("upserts one grant for the named user", async () => {
    const res = await PUT(put({ userId: "u1", relation: "owner" }), { params });
    expect(res.status).toBe(200);
    expect(grantUpdateOne).toHaveBeenCalledWith(
      { subject: "u1", objectType: "project", object: PROJECT },
      { $set: { relation: "owner" }, $setOnInsert: { createdBy: "o1" } },
      { upsert: true }
    );
  });

  it("rejects a relation that is not owner or member", async () => {
    const res = await PUT(put({ userId: "u1", relation: "root" }), { params });
    expect(res.status).toBe(400);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not an owner of this project", async () => {
    check.mockResolvedValue(false);
    const res = await PUT(put({ userId: "u1", relation: "owner" }), { params });
    expect(res.status).toBe(403);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses to demote the last owner", async () => {
    grantCountDocuments.mockResolvedValue(1);
    const res = await PUT(put({ userId: "u1", relation: "member" }), { params });
    expect(res.status).toBe(409);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("survives a concurrent double submit", async () => {
    grantUpdateOne.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: 11000 }));
    const res = await PUT(put({ userId: "u1", relation: "owner" }), { params });
    expect(res.status).toBe(200);
  });
});

describe("DELETE members", () => {
  it("removes the grant for the named user", async () => {
    const url = `http://x/api/projects/${PROJECT}/members?userId=u2`;
    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(200);
    expect(grantDeleteOne).toHaveBeenCalledWith({
      subject: "u2",
      objectType: "project",
      object: PROJECT,
    });
  });

  it("refuses to remove the last owner", async () => {
    grantCountDocuments.mockResolvedValue(1);
    grantFindLean.mockResolvedValue([{ subject: "u2", relation: "owner" }]);
    const url = `http://x/api/projects/${PROJECT}/members?userId=u2`;
    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(409);
    expect(grantDeleteOne).not.toHaveBeenCalled();
  });
});
```

**[review]** The last-owner guard, the duplicate-key case and the two filter assertions all exist because the review found them missing. `src/app/api/users/[userId]/route.ts:43-51` already refuses to demote the last instance admin, so this is the codebase's own established guard, not a new invention.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run "src/app/api/projects/[projectId]/members/route.test.ts"`
Expected: FAIL — `PUT is not a function`.

- [ ] **Step 3: Implement the route**

Replace `src/app/api/projects/[projectId]/members/route.ts` entirely:

```ts
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { User } from "@/models/user";
import { Grant } from "@/models/grant";
import { GRANT_RELATIONS, GrantRelation } from "@/types";

async function ownerCount(projectId: string): Promise<number> {
  return Grant.countDocuments({ objectType: "project", object: projectId, relation: "owner" });
}

export const GET = withProjectOwner(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const [users, grants] = await Promise.all([
    User.find({ kind: { $ne: "machine" } })
      .select("username fullName role")
      .sort({ username: 1 })
      .lean(),
    Grant.find({ objectType: "project", object: projectId }).select("subject relation").lean(),
  ]);

  const byUser = new Map(grants.map((g) => [String(g.subject), g.relation]));

  return NextResponse.json(
    users.map((u) => ({
      _id: String(u._id),
      username: u.username,
      fullName: u.fullName,
      relation: byUser.get(String(u._id)) ?? null,
      instanceAdmin: u.role === "admin",
    }))
  );
});

export const PUT = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  const body = (await request.json().catch(() => null)) ?? {};
  const { userId, relation } = body as { userId?: string; relation?: GrantRelation };

  if (!userId || !relation || !GRANT_RELATIONS.includes(relation)) {
    return NextResponse.json(
      { error: "userId and a relation of owner or member are required" },
      { status: 400 }
    );
  }

  await connectDB();
  const target = await User.findById(userId).select("_id role kind");
  if (!target || target.kind === "machine") {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (relation !== "owner" && (await ownerCount(projectId)) <= 1) {
    return NextResponse.json(
      { error: "A board must keep at least one owner" },
      { status: 409 }
    );
  }

  try {
    await Grant.updateOne(
      { subject: userId, objectType: "project", object: projectId },
      { $set: { relation }, $setOnInsert: { createdBy: user._id } },
      { upsert: true }
    );
  } catch (e) {
    // Two concurrent grants of the same pair race the unique index; the row exists either way
    if ((e as { code?: number }).code !== 11000) throw e;
  }

  return NextResponse.json({ ok: true });
});

export const DELETE = withProjectOwner(async (request, { params }) => {
  const { projectId } = await params;
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  await connectDB();
  if ((await ownerCount(projectId)) <= 1) {
    const remaining = await Grant.find({ objectType: "project", object: projectId })
      .select("subject relation")
      .lean();
    const isLastOwner = remaining.some(
      (g) => String(g.subject) === userId && g.relation === "owner"
    );
    if (isLastOwner) {
      return NextResponse.json(
        { error: "A board must keep at least one owner" },
        { status: 409 }
      );
    }
  }

  await Grant.deleteOne({ subject: userId, objectType: "project", object: projectId });

  return NextResponse.json({ ok: true });
});
```

In `src/types/index.ts` replace `ApiProjectMember` with:

```ts
export interface ApiProjectMember {
  _id: string;
  username: string;
  fullName: string;
  relation: GrantRelation | null;
  instanceAdmin: boolean;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run "src/app/api/projects/[projectId]/members/route.test.ts"`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(auth): grant and revoke project roles through the members API"
```

---

### Task 6: Member management in project settings

**Files:**
- Modify: `src/app/(app)/projects/[projectId]/settings/sections/GeneralSection.tsx`

- [ ] **Step 1: Replace the admins picker with a role list**

Delete `newAdminId`, `adminsSaving`, `saveAdmins`, and the `ownerName`/`ownerId` derivation. Add:

```tsx
async function setRelation(userId: string, relation: string) {
  try {
    if (relation === "none") {
      await api.del(`/api/projects/${projectId}/members?userId=${userId}`);
    } else {
      await api.put(`/api/projects/${projectId}/members`, { userId, relation });
    }
    setMembers(await api.get(`/api/projects/${projectId}/members`));
    toast("Access updated", "success");
  } catch (err) {
    toast(err instanceof Error ? err.message : "Failed to update access", "error");
  }
}
```

and replace the "Who can change settings" card:

```tsx
<SettingsCard
  title="Who can use this board"
  description="Owners can change everything on this page. Members work on tasks and sprints. Instance admins always have full access and are listed for reference."
>
  <div className="space-y-2">
    {members.map((m) => (
      <ListRow key={m._id}>
        <span className="text-sm font-medium">{m.fullName || m.username}</span>
        {m.instanceAdmin ? (
          <span className="text-sm text-text-muted">Instance admin</span>
        ) : (
          <select
            value={m.relation ?? "none"}
            onChange={(e) => setRelation(m._id, e.target.value)}
            className="rounded-md border border-border bg-bg-input px-2 py-1 text-sm"
            aria-label={`Access for ${m.username}`}
          >
            <option value="none">No access</option>
            <option value="member">Member</option>
            <option value="owner">Owner</option>
          </select>
        )}
      </ListRow>
    ))}
  </div>
</SettingsCard>
```

Check the actual `SettingsCard` and `ListRow` prop signatures in `src/components/settings/` before pasting; the JSX above assumes the shape the file already uses for its other cards.

A native `<select>` is deliberate — keyboard-accessible for free, and the pattern the board's list view already uses for status and assignee.

- [ ] **Step 2: Check nothing still sends `admins`**

Run: `grep -rn "admins" src/app src/components src/types src/lib`
Expected: only `src/types/index.ts:877` (`admins?: ApiProjectMember[]`), removed in Task 8. **[review]** `src/types` was outside revision 1's grep, which is how the dead API shape survived both of its verification steps.

- [ ] **Step 3: Build**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(settings): manage board access by role instead of an admins list"
```

---

### Task 7: Per-user project assignment in instance settings

**Files:**
- Modify: `src/app/api/users/[userId]/route.ts:56-72`, `src/app/(app)/settings/users/page.tsx:79-100`

- [ ] **Step 1: Stop accepting allowedProjects on the user route**

Delete the whole `if (body.allowedProjects !== undefined) { … }` block (lines 56-72). Leave the self-demotion and last-admin guards at `:36` and `:43-51` untouched.

- [ ] **Step 2: Drop the project picker from the users page**

Remove `editProjects`/`setEditProjects`, the `allowedProjects` line in `openEdit`, the `allowedProjects` key in the `api.put` payload, and the project checkbox list. Add below the role field:

```tsx
<p className="text-sm text-text-muted">
  Board access is granted per board, under that board&apos;s Settings → General.
</p>
```

- [ ] **Step 3: Run the suite and build**

Run: `npx vitest run && npm run build`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(settings): grant board access per board rather than per user"
```

---

### Task 8: Remove the old fields

**Files:**
- Modify: `src/models/user.ts:48-51`, `src/models/project.ts:239-247`
- Modify: `src/types/index.ts` — `IUser.allowedProjects`, `IProject.owner`, `IProject.admins`, `ApiProject.owner` (`:876`), `ApiProject.admins` (`:877`), `ApiProjectMember.role` (`:887`), `ApiUser.allowedProjects` (`:820`)
- Modify: `src/app/api/projects/route.ts` (POST), `src/app/api/projects/[projectId]/route.ts:28-29, :71-105, :216-217`
- Modify: `src/lib/pm/pm-user.ts:26`, `src/lib/worker-user.ts:45`
- Modify: `src/app/api/auth/me/route.ts`, `src/app/oauth/authorize/route.ts:154`, `src/app/api/tokens/route.ts:41`

**[review]** Revision 1's line citations in this task were wrong in five places and it missed `worker-user.ts` and the four `Api*` type shapes entirely. The numbers above are re-read from the tree.

- [ ] **Step 1: Decide what happens to the stored `owner` value**

**[review]** Renaming a Mongoose schema path does **not** rename the field in stored documents. With no backfill, renaming `owner` → `createdBy` leaves every existing project with an unmapped `owner` and an empty `createdBy`, and `.populate("createdBy", …)` yields `null` — silently, because Mongoose does not validate on update.

So: make `createdBy` **not** `required`, and add to the spec that it is empty for every board that existed before this deploy. It is informational only, so an empty value costs nothing — but a `required: true` path that is empty in every document is a trap for the next person.

In `src/models/project.ts`, replace the `owner` field (`:239-243`) with:

```ts
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
```

and delete the `admins` field (`:244-247`).

- [ ] **Step 2: Update the project routes**

In `src/app/api/projects/[projectId]/route.ts`: change `.populate("owner", …)` to `.populate("createdBy", …)` at `:28` and `:216`, delete `.populate("admins", …)` at `:29` and `:217`, and delete the whole `if (body.admins !== undefined) { … }` block (`:71-105`).

In `src/app/api/projects/route.ts` (POST) change `owner: user._id` to `createdBy: user._id` and `.populate("owner", …)` to `.populate("createdBy", …)`.

- [ ] **Step 3: Grant the creator ownership, and fail loudly if that cannot happen**

Still in `POST /api/projects`, replace the `Project.create` block with:

```ts
  const project = await Project.create({
    name,
    key,
    description: description || "",
    createdBy: user._id,
    customFields: legacyFieldSeeds({}),
  });

  try {
    await Grant.create({
      subject: user._id,
      relation: "owner",
      objectType: "project",
      object: project._id,
      createdBy: user._id,
    });
  } catch (e) {
    await Project.deleteOne({ _id: project._id });
    throw e;
  }
```

**[review]** Without the rollback a failed grant leaves a board with no owner at all — the exact state this step exists to prevent.

- [ ] **Step 4: Remove allowedProjects from the user model and its two writers**

Delete the `allowedProjects` field from `src/models/user.ts:48-51` and from `IUser`. Delete `allowedProjects: []` from `src/lib/pm/pm-user.ts:26` **and from `src/lib/worker-user.ts:45`**, where it sits inside a `$setOnInsert`. Mongoose's `UpdateQuery` typing will not reject that key once the schema path is gone, so the build stays green and it survives as a silent no-op unless removed by hand.

- [ ] **Step 5: Remove the dead API shapes**

In `src/types/index.ts` delete `IProject.owner`, `IProject.admins`, `ApiProject.owner` (`:876`), `ApiProject.admins` (`:877`), `ApiProjectMember.role` (`:887`) and `ApiUser.allowedProjects` (`:820`). Add `createdBy?: ApiUser | string;` to `ApiProject`. Fix whatever the build then reports.

- [ ] **Step 6: Drop the allowedProjects key from /api/auth/me**

Remove the key entirely rather than publishing `[]` for instance admins. Nothing reads it: verified by `grep -rn "allowedProjects" src/app src/components` returning only the users page (changed in Task 7) and the tokens page (token scopes).

- [ ] **Step 7: Fix the two token-minting project pickers**

`src/app/oauth/authorize/route.ts:154` and `src/app/api/tokens/route.ts:41` each build a filter of projects the minting user may scope a token to:

```ts
  const accessible = await accessibleProjectIds(user);
  const filter = accessible === null ? {} : { _id: { $in: accessible } };
```

Every `allowedProjects` field on `apiToken`, `oauthToken` and `oauthCode` stays untouched.

- [ ] **Step 8: Prove the removal is complete**

```bash
grep -rln "allowedProjects" src
```
Expected exactly: `src/lib/auth.ts`, `src/models/apiToken.ts`, `src/models/oauthToken.ts`, `src/models/oauthCode.ts`, `src/types/index.ts`, `src/app/api/tokens/route.ts`, `src/app/oauth/token/route.ts`, `src/app/oauth/authorize/route.ts`, `src/app/api/oauth/connections/route.ts`, `src/app/(app)/settings/tokens/page.tsx` — all token scope, all intended.

```bash
grep -rn "admins" src
grep -rn "project\.owner\|\"owner\"" src --include="*.ts" --include="*.tsx"
```
Expected: no output from the first; from the second only git-remote `owner/repo` strings.

- [ ] **Step 9: Run the suite and build**

Run: `npx vitest run && npm run build`

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(auth): drop project.admins and user.allowedProjects"
```

---

### Task 9: Live verification

The suite mocks Mongoose throughout, so it cannot prove the unique index exists, that the upsert upserts, or that login survives. **A green suite is not evidence for any claim below.** Do not commit code in this task; a defect found here gets its own task.

- [ ] **Step 1: Snapshot production-shaped data first**

`scripts/dump-collections.ts` defaults to `["projects", "tasks"]`, so pass the collections this change actually touches:

```bash
npx tsx scripts/dump-collections.ts users grants projects
```

- [ ] **Step 2: Bring the app up**

`.env.local` exists and Mongo listens on 27017. Use `preview_start {name: "claudeplanner-dev"}` (port 3456). Never start a dev server through Bash.

- [ ] **Step 3: Confirm the empty-collection state**

With no grants: an instance admin has full access to every board. `boardadmin` (seeded, `test123`) sees an empty projects list, and `/projects/TP` 403s cleanly with no stack trace in `preview_logs`.

- [ ] **Step 4: Confirm the old fields survived in Mongo**

This is what makes hand-assignment a five-minute job and keeps rollback possible: dropping a schema path does not delete stored data. Read and record:

```
db.users.find({}, { username: 1, allowedProjects: 1 })
db.projects.find({}, { key: 1, owner: 1, admins: 1 })
```

Both should still show the pre-migration values. Paste the output into CP-246.

- [ ] **Step 5: Grant through the UI, confirm no re-login is needed**

As the instance admin open `/projects/TP/settings`, set `boardadmin` to **Owner** and `plainuser` to **Member**. In `boardadmin`'s existing session, reload — board and Settings link both appear.

- [ ] **Step 6: Walk the matrix as each role**

As `boardadmin` (owner): edit the project name, open Board columns, add a webhook, open the members list, **delete a throwaway project you created for this** (capability move 1), and open the PM agent OAuth screen (capability move 2). As `plainuser` (member): create and edit a task, create a sprint, then confirm `/projects/TP/settings` is refused and the sidebar has no Settings link.

- [ ] **Step 7: Try to strand a board**

As `boardadmin`, attempt to set yourself to Member and to remove yourself while you are the only owner. Both must be refused with the 409 from Task 5, and the board must still be reachable afterwards.

- [ ] **Step 8: Verify the index is real**

Mocked Mongoose cannot prove this. From a scratchpad script against `mongodb://localhost:27017/claudeplanner`, read `db.grants.getIndexes()` and confirm `{subject: 1, objectType: 1, object: 1}` is present **and unique**. Then attempt a duplicate `insertOne` and confirm error 11000.

- [ ] **Step 9: Verify token minting and scoped-token behaviour**

In the UI as `boardadmin`, mint a token at `/settings/tokens` scoped to TP — confirm TP is offered at all (that is `accessibleProjectIds` on the minting path). With that token: `GET /api/projects` shows TP with `canAdmin` **false**; `PUT /api/projects/:id/members` is refused.

- [ ] **Step 10: Verify the instance admin's scoped token**

Mint a token scoped to TP as the **instance admin**. `GET /api/projects/TP/tasks` must succeed; `PUT /api/projects/TP` must 403. Then `POST /api/projects/TP/pm/chat` must succeed, and the same call against a project outside the scope must 403 — that route authenticates by hand and is the one the review caught. A failure on the first two means `instanceAdminBeforeScope` is not reaching `decide()`.

- [ ] **Step 11: Write the results into CP-246**

Record which paths were driven for real and which were synthesised, paste the index output and the Step 4 reads, and state plainly anything not exercised.

---

## Self-Review

**Spec coverage.** Roles → Tasks 3-5. Matrix → Tasks 3, 4, and 9 step 6, which now exercises both capability moves rather than only asserting them. Data model → Task 1. `check()` and the rule-3 trap → Tasks 1, 2, and 9 step 10. Token scope is not a grant → Tasks 2, 3, 8. Removals → Task 8. No migration → Task 9 steps 3 and 4. API and UI → Tasks 4-7.

**Placeholders.** None: every code step carries code, every verification step carries the command and the expected output.

**Type consistency.** `decide`/`principalOf`/`check`/`accessibleProjectIds` keep one signature throughout. `Need` is `"access" | "admin"`; `GrantRelation` is `"owner" | "member"` in model, API and `ApiProjectMember`. `accessibleProjectIds` returns `string[] | null` and every consumer handles `null` explicitly.

**Deliberate, flagged deviations.** (a) `withProjectOwner` answers 403 rather than 404 for a non-existent project, for non-admins — consistent with `unresolvedProject`. (b) `GET …/members` returns every human account, the third capability change, recorded in Global Constraints. (c) `project.createdBy` is empty for every board created before this deploy, and is `default: null` rather than `required` for that reason. (d) An owner can run PM MCP OAuth against servers only an instance admin can configure.

**Spec edits this revision requires.** The spec still says "61 references across 22 files" (real: 73/27) and still lists exactly two capability moves. Update both, and add the `pm.mcpServers` and `createdBy`-is-empty footnotes, before starting Task 1.
