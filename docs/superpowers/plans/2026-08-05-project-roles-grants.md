# Project Roles on a Grants Collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `user.allowedProjects[]` + `project.owner` + `project.admins[]` with one `grants` collection and three roles — instance `admin`, project `owner`, project `member`.

**Architecture:** A tuple-shaped `grants` collection (`{subject, relation, objectType, object}`) is the single source of truth. Authorisation splits into a **pure decision function** over a principal and at most one grant row, and a **thin lookup** that fetches that row. No graph traversal, no rewrite rules — `owner ⊃ member` is one hardcoded implication.

**Tech Stack:** Next.js 16 App Router, TypeScript, Mongoose, Vitest, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-05-project-roles-grants-design.md`
**Task:** CP-246. **Branch:** `cp-246/project-roles-grants` (already exists, holds the spec commits).

## Global Constraints

- **No backfill script.** rpo assigns grants by hand after deploy. An empty `grants` collection must leave instance admins working and everyone else cleanly denied — never crash.
- **The `member` row is transcribed 1:1.** Exactly two capabilities move: deleting a project and the PM agent MCP OAuth/test endpoints go from instance admin to owner. Anything else changing who can do what is a bug in this plan. Sprint deletion and custom-field editing stay with `member` even though they are inconsistent — that is CP-247.
- **Token scope fields stay put.** `apiToken.allowedProjects`, `oauthToken.allowedProjects`, `oauthCode.allowedProjects` are scopes, not grants. Do not touch them.
- **Instance admins hold no grant rows.** Their access comes from `role === "admin"`. Never write grants for them.
- MongoDB 4.4: no `$dateTrunc`, `$dateAdd`/`$dateDiff`, `$setWindowFields`, and no `$lookup` mixing `localField`/`foreignField` with an inline `pipeline`.
- Comments: default to none. Only a one-liner for a genuinely non-obvious workaround. No javadoc, no narration.
- Code, commits and PR text in English. Conventional commits. No `Co-Authored-By`, no generated-with footer.
- Every commit must leave `npx vitest run` green. Intermediate commits may leave the local app unusable until grants are seeded; that is expected and called out where it happens.

---

## File Structure

**Created**
- `src/models/grant.ts` — the Mongoose schema and its two indexes. Nothing else.
- `src/lib/grants.ts` — authorisation. `decide()` (pure), `check()` and `accessibleProjectIds()` (one query each), `principalOf()`.
- `src/lib/grants.test.ts` — the permission matrix as pure-logic tests.
- `src/app/api/projects/[projectId]/members/route.test.ts` — grant/revoke API tests.

**Modified**
- `src/types/index.ts` — `IGrant`, `GrantRelation`; two runtime-only fields on `IUser`; drop `allowedProjects` and `IProject.admins` at the end.
- `src/lib/auth.ts` — `applyTokenScope` records the scope and the pre-downgrade admin flag instead of rewriting `allowedProjects`.
- `src/lib/middleware.ts` — `withProjectAccess` and `withProjectOwner` (renamed from `withProjectAdmin`) delegate to `check()`; `canAdminProject` is deleted.
- `src/models/project.ts` — `admins` removed, `owner` renamed `createdBy`.
- `src/models/user.ts` — `allowedProjects` removed.
- Route handlers listed per task.
- `src/app/(app)/projects/[projectId]/settings/sections/GeneralSection.tsx` — member management replaces the admins picker.
- `src/app/(app)/settings/users/page.tsx` — per-user project assignment moves onto grants.

---

### Task 1: Grant model and the pure decision function

The whole permission matrix becomes testable without a database. Everything later in the plan leans on `decide()`.

**Files:**
- Create: `src/models/grant.ts`
- Create: `src/lib/grants.ts`
- Create: `src/lib/grants.test.ts`
- Modify: `src/types/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GrantRelation = "owner" | "member"`
  - `type Need = "access" | "admin"`
  - `interface Principal { instanceAdmin: boolean; tokenScoped: boolean; tokenScope: string[] | null; instanceAdminBeforeScope: boolean }`
  - `function decide(principal: Principal, grant: GrantRelation | null, need: Need, projectId: string): boolean`
  - `function principalOf(user: IUser): Principal`
  - `const Grant: Model<IGrant>`

- [ ] **Step 1: Add the types**

In `src/types/index.ts`, next to the other model interfaces:

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

In `interface IUser`, directly below the existing `tokenScoped` field, add:

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

  // The regression the spec is built around: applyTokenScope downgrades an instance admin to
  // member, and instance admins hold no grant rows, so a naive lookup strips all their access.
  it("keeps an instance admin's scoped token working inside its scope", () => {
    const p = principal({
      tokenScoped: true,
      tokenScope: [P],
      instanceAdminBeforeScope: true,
    });
    expect(decide(p, null, "access", P)).toBe(true);
    expect(decide(p, null, "admin", P)).toBe(false);
  });

  it("still confines an instance admin's scoped token to its scope", () => {
    const p = principal({
      tokenScoped: true,
      tokenScope: [OTHER],
      instanceAdminBeforeScope: true,
    });
    expect(decide(p, null, "access", P)).toBe(false);
  });

  it("treats an unscoped token as its owner, admin rights included", () => {
    const p = principal({ instanceAdmin: true, tokenScoped: false, tokenScope: null });
    expect(decide(p, null, "admin", P)).toBe(true);
  });
});
```

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

- [ ] **Step 6: Run the tests and confirm they pass**

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
- Modify: `src/lib/grants.ts`
- Modify: `src/lib/grants.test.ts`
- Modify: `src/lib/auth.ts:66-77`

**Interfaces:**
- Consumes: `decide`, `principalOf`, `Grant` from Task 1.
- Produces:
  - `async function check(user: IUser, projectId: string, need: Need): Promise<boolean>`
  - `async function accessibleProjectIds(user: IUser): Promise<string[] | null>` — `null` means "no restriction", i.e. an unscoped instance admin.

**Do NOT remove `user.allowedProjects = effective` from `applyTokenScope` in this task.** The middleware still reads `allowedProjects` until Task 3; dropping the narrowing here would widen a scoped token's reach for one commit. Task 3 removes that line.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/grants.test.ts`:

```ts
import { vi } from "vitest";

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

Add `beforeEach` to the vitest import at the top of the file.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/grants.test.ts`
Expected: FAIL — `check is not a function`.

- [ ] **Step 3: Implement both functions**

Append to `src/lib/grants.ts` (and add the imports `connectDB` from `./db` and `Grant` from `@/models/grant`):

```ts
export async function check(user: IUser, projectId: string, need: Need): Promise<boolean> {
  const principal = principalOf(user);
  if (principal.tokenScope && !principal.tokenScope.includes(projectId)) return false;
  if (principal.instanceAdmin || principal.instanceAdminBeforeScope) {
    return decide(principal, null, need, projectId);
  }

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

- [ ] **Step 4: Record the scope on the principal in auth.ts**

Replace `applyTokenScope` in `src/lib/auth.ts:66-77` with:

```ts
function applyTokenScope(user: IUser, scope: Types.ObjectId[]): IUser {
  user.instanceAdminBeforeScope = user.role === "admin";
  user.role = "member";
  user.tokenScope = scope;
  user.allowedProjects =
    user.instanceAdminBeforeScope
      ? scope
      : (user.allowedProjects || []).filter((p) =>
          scope.some((s) => s.toString() === p.toString())
        );
  user.tokenScoped = true;
  return user;
}
```

The `allowedProjects` narrowing is unchanged and stays until Task 3. Only the two new fields are added. Keep the existing comment above the function.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — 13 new tests in `grants.test.ts`, everything else unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/lib/grants.ts src/lib/grants.test.ts src/lib/auth.ts
git commit -m "feat(auth): resolve grants and carry token scope on the principal"
```

---

### Task 3: Middleware and the project list read from grants

After this commit the app authorises entirely from `grants`. **Local dev will show no projects to non-admins until you insert a grant row** — expected, not a bug.

**Files:**
- Modify: `src/lib/middleware.ts` — delete `canAdminProject`, rewrite `withProjectAccess`, rename `withProjectAdmin` → `withProjectOwner`
- Modify: `src/lib/auth.ts` — drop the `allowedProjects` narrowing
- Modify: `src/app/api/projects/route.ts:14-17` — filter on grants
- Modify: `src/app/api/search/route.ts:27`, `src/app/api/tasks/mine/route.ts:14`
- Modify: every file importing `withProjectAdmin` (7 route files, listed below)

**Interfaces:**
- Consumes: `check`, `accessibleProjectIds` from Task 2.
- Produces: `withProjectOwner(handler)` replacing `withProjectAdmin`; `canAdminProject` no longer exists.

- [ ] **Step 1: Rewrite the two middlewares**

In `src/lib/middleware.ts`, delete `refId` and `canAdminProject` entirely (lines 86-104), add `import { check, accessibleProjectIds } from "./grants";`, and replace the bodies:

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

`withProjectAccessOrWorker` needs no change — its worker branch resolves the identity itself and never consults grants, and its person branch calls the rewritten `withProjectAccess`.

Note the behaviour change in `withProjectOwner`: a missing project now returns 403 rather than 404 for a non-admin, because the grant lookup fails before any project lookup. That matches the `unresolvedProject` policy of not leaking which projects exist.

- [ ] **Step 2: Drop the allowedProjects narrowing**

In `src/lib/auth.ts`, `applyTokenScope` becomes:

```ts
function applyTokenScope(user: IUser, scope: Types.ObjectId[]): IUser {
  user.instanceAdminBeforeScope = user.role === "admin";
  user.role = "member";
  user.tokenScope = scope;
  user.tokenScoped = true;
  return user;
}
```

- [ ] **Step 3: Rename every call site**

Replace `withProjectAdmin` with `withProjectOwner` in:

```bash
grep -rl "withProjectAdmin" src | xargs sed -i '' 's/withProjectAdmin/withProjectOwner/g'
```

Files touched: `projects/[projectId]/route.ts`, `categories/route.ts`, `coda/sync/route.ts`, `columns/route.ts`, `custom-fields/[fieldId]/route.ts`, `members/route.ts`, `notifications/route.ts`, `webhooks/route.ts`, plus `src/lib/middleware.ts`.

- [ ] **Step 4: Move the three list queries onto grants**

`src/app/api/projects/route.ts` — replace lines 14-17 and the `canAdmin` line added by CP-245:

```ts
  const ids = await accessibleProjectIds(user);
  const filter = ids === null ? {} : { _id: { $in: ids } };
```

and inside the `map`, replace the `canAdminProject` call with:

```ts
    obj.canAdmin = await check(user, String(p._id), "admin");
```

Because `map` now returns promises, wrap it: `const sanitized = await Promise.all(projects.map(async (p) => { … }));`

`src/app/api/search/route.ts:27` and `src/app/api/tasks/mine/route.ts:14` — replace `const allowed = user.allowedProjects || [];` with:

```ts
  const allowed = (await accessibleProjectIds(user)) ?? [];
```

In both files the surrounding code already branches on `user.role === "admin"` to skip the filter; leave that branch alone — `accessibleProjectIds` returning `null` only happens on that same branch, and `?? []` keeps the non-admin path correct.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. If a route test fails because it stubbed `allowedProjects` on a fake user, update that fixture to mock `@/lib/grants`'s `check` instead — the fixture was asserting the old source of truth.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: exit 0. A TypeScript error naming `canAdminProject` means a call site was missed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(auth): authorise from grants instead of allowedProjects and admins[]"
```

---

### Task 4: Move project delete and the PM agent endpoints to the owner

The only two capability changes in this plan.

**Files:**
- Modify: `src/app/api/projects/[projectId]/route.ts:220` — `withAdmin` → `withProjectOwner`
- Modify: `src/app/api/projects/[projectId]/pm/mcp-test/route.ts:9`
- Modify: `src/app/api/projects/[projectId]/pm/mcp-oauth/start/route.ts:18`
- Modify: `src/app/api/projects/[projectId]/pm/mcp-oauth/disconnect/route.ts:6`

**Interfaces:**
- Consumes: `withProjectOwner` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Swap the middleware in all four routes**

In each of the four files, change the import from `withAdmin` to `withProjectOwner` (keep other imports) and the wrapper on the listed export. `DELETE` in `projects/[projectId]/route.ts` becomes:

```ts
export const DELETE = withProjectOwner(async (_request, { params }) => {
```

- [ ] **Step 2: Verify nothing else in those files depended on withAdmin**

Run: `grep -n "withAdmin" src/app/api/projects/[projectId]/route.ts src/app/api/projects/[projectId]/pm/mcp-*/**/route.ts src/app/api/projects/[projectId]/pm/mcp-test/route.ts`
Expected: no output.

- [ ] **Step 3: Run the suite and build**

Run: `npx vitest run && npm run build`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(auth): let a project owner delete the board and run its PM agent OAuth"
```

---

### Task 5: Members API on grants

**Files:**
- Modify: `src/app/api/projects/[projectId]/members/route.ts`
- Create: `src/app/api/projects/[projectId]/members/route.test.ts`
- Modify: `src/types/index.ts` — extend `ApiProjectMember` with `relation`

**Interfaces:**
- Consumes: `Grant`, `withProjectOwner`.
- Produces:
  - `GET /api/projects/:projectId/members` → `{ _id, username, fullName, relation: "owner" | "member" | null, instanceAdmin: boolean }[]`
  - `PUT /api/projects/:projectId/members` with `{ userId, relation }` → upserts one grant
  - `DELETE /api/projects/:projectId/members?userId=…` → removes the grant

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/projects/[projectId]/members/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const grantFind = vi.fn();
const grantUpdateOne = vi.fn();
const grantDeleteOne = vi.fn();
const userFind = vi.fn();
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
    find: () => ({ select: () => ({ lean: grantFind }) }),
    updateOne: grantUpdateOne,
    deleteOne: grantDeleteOne,
  },
}));
vi.mock("@/models/user", () => ({
  User: { find: () => ({ select: () => ({ sort: () => ({ lean: userFind }) }) }) },
}));
vi.mock("@/models/project", () => ({ Project: { findOne: vi.fn() } }));
vi.mock("@/models/task", () => ({ Task: {} }));

const { GET, PUT, DELETE } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const OWNER = { _id: "o1", role: "member" };
const params = Promise.resolve({ projectId: PROJECT });

function req(body?: unknown, url = `http://x/api/projects/${PROJECT}/members`) {
  return new Request(url, {
    method: body ? "PUT" : "GET",
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  grantFind.mockResolvedValue([]);
  userFind.mockResolvedValue([]);
  grantUpdateOne.mockReset();
  grantDeleteOne.mockReset();
});

describe("GET members", () => {
  it("labels each user with their relation on this project", async () => {
    userFind.mockResolvedValue([
      { _id: "u1", username: "ann", fullName: "Ann", role: "member" },
      { _id: "u2", username: "bo", fullName: "Bo", role: "member" },
    ]);
    grantFind.mockResolvedValue([{ subject: "u1", relation: "owner" }]);

    const res = await GET(req(), { params });
    const body = await res.json();

    expect(body).toEqual([
      { _id: "u1", username: "ann", fullName: "Ann", relation: "owner", instanceAdmin: false },
      { _id: "u2", username: "bo", fullName: "Bo", relation: null, instanceAdmin: false },
    ]);
  });

  it("marks instance admins, who hold no grants", async () => {
    userFind.mockResolvedValue([{ _id: "a1", username: "root", fullName: "Root", role: "admin" }]);
    const res = await GET(req(), { params });
    const body = await res.json();
    expect(body[0]).toMatchObject({ relation: null, instanceAdmin: true });
  });
});

describe("PUT members", () => {
  it("upserts one grant for the named user", async () => {
    const res = await PUT(req({ userId: "u1", relation: "owner" }), { params });
    expect(res.status).toBe(200);
    expect(grantUpdateOne).toHaveBeenCalledWith(
      { subject: "u1", objectType: "project", object: PROJECT },
      { $set: { relation: "owner" }, $setOnInsert: { createdBy: "o1" } },
      { upsert: true }
    );
  });

  it("rejects a relation that is not owner or member", async () => {
    const res = await PUT(req({ userId: "u1", relation: "root" }), { params });
    expect(res.status).toBe(400);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not an owner of this project", async () => {
    check.mockResolvedValue(false);
    const res = await PUT(req({ userId: "u1", relation: "owner" }), { params });
    expect(res.status).toBe(403);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });
});

describe("DELETE members", () => {
  it("removes the grant for the named user", async () => {
    const url = `http://x/api/projects/${PROJECT}/members?userId=u1`;
    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(200);
    expect(grantDeleteOne).toHaveBeenCalledWith({
      subject: "u1",
      objectType: "project",
      object: PROJECT,
    });
  });
});
```

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

  await Grant.updateOne(
    { subject: userId, objectType: "project", object: projectId },
    { $set: { relation }, $setOnInsert: { createdBy: user._id } },
    { upsert: true }
  );

  return NextResponse.json({ ok: true });
});

export const DELETE = withProjectOwner(async (request, { params }) => {
  const { projectId } = await params;
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  await connectDB();
  await Grant.deleteOne({ subject: userId, objectType: "project", object: projectId });

  return NextResponse.json({ ok: true });
});
```

The test mocks `User.findById` implicitly through the `@/models/user` mock; extend that mock with `findById: () => ({ select: () => Promise.resolve({ _id: "u1", role: "member", kind: "human" }) })` so the PUT tests reach the upsert.

In `src/types/index.ts`, replace the `ApiProjectMember` interface with:

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
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(auth): grant and revoke project roles through the members API"
```

---

### Task 6: Member management in project settings

**Files:**
- Modify: `src/app/(app)/projects/[projectId]/settings/sections/GeneralSection.tsx`

**Interfaces:**
- Consumes: the members API from Task 5, `ApiProjectMember` with `relation` and `instanceAdmin`.
- Produces: nothing other tasks read.

- [ ] **Step 1: Replace the admins picker with a role list**

In `GeneralSection.tsx`, delete `newAdminId`, `adminsSaving` and `saveAdmins`, and the `ownerName`/`ownerId` derivation. Replace the "Who can change settings" card's body with a list of `members` where each row carries a native `<select>` bound to that member's relation:

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

A native `<select>` is deliberate: it is keyboard-accessible for free and it is the pattern the board's list view already uses for status and assignee.

- [ ] **Step 2: Check nothing else still sends `admins`**

Run: `grep -rn "admins" src/app src/components`
Expected: no hits outside the settings copy you just replaced. Anything left is a call site to fix now.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(settings): manage board access by role instead of an admins list"
```

---

### Task 7: Per-user project assignment in instance settings

**Files:**
- Modify: `src/app/(app)/settings/users/page.tsx:79-100`
- Modify: `src/app/api/users/[userId]/route.ts:56-72`

**Interfaces:**
- Consumes: `Grant`.
- Produces: `PUT /api/users/:id` accepts `{ role }` only; project assignment moves to the members API.

- [ ] **Step 1: Stop accepting allowedProjects on the user route**

In `src/app/api/users/[userId]/route.ts`, delete the whole `if (body.allowedProjects !== undefined) { … }` block (lines 56-72). Instance-level user editing now covers the instance role only; board access is granted per board.

- [ ] **Step 2: Drop the project picker from the users page**

In `src/app/(app)/settings/users/page.tsx`, remove `editProjects`/`setEditProjects`, the `allowedProjects` line in `openEdit`, the `allowedProjects` key in the `api.put` payload, and the project checkbox list from the edit dialog. Add below the role field:

```tsx
<p className="text-sm text-text-muted">
  Board access is granted per board, under that board&apos;s Settings → General.
</p>
```

- [ ] **Step 3: Run the suite and build**

Run: `npx vitest run && npm run build`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(settings): grant board access per board rather than per user"
```

---

### Task 8: Remove the old fields

Last code task. Nothing should read these any more; this makes that true by construction.

**Files:**
- Modify: `src/models/user.ts:42-45`, `src/models/project.ts:229-237`
- Modify: `src/types/index.ts` — `IUser.allowedProjects`, `IProject.admins`, `IProject.owner`
- Modify: `src/app/api/auth/me/route.ts:27`, `src/lib/pm/pm-user.ts:26`
- Modify: `src/app/api/projects/route.ts`, `src/app/api/projects/[projectId]/route.ts`
- Modify: `src/app/oauth/authorize/route.ts:154`, `src/app/api/tokens/route.ts:41`

**Interfaces:**
- Consumes: `accessibleProjectIds` from Task 2.
- Produces: `project.createdBy` replaces `project.owner`; `user.allowedProjects` no longer exists.

- [ ] **Step 1: Rename owner to createdBy**

In `src/models/project.ts`, rename the `owner` field to `createdBy` and delete the `admins` field. In `src/types/index.ts`, rename `IProject.owner` to `createdBy` and delete `IProject.admins`.

In `src/app/api/projects/route.ts` (POST) change `owner: user._id` to `createdBy: user._id` and `.populate("owner", …)` to `.populate("createdBy", …)`. Do the same for both `.populate` calls in `src/app/api/projects/[projectId]/route.ts` (lines 29 and 217) and delete the `.populate("admins", …)` calls and the whole `if (body.admins !== undefined) { … }` validation block (lines 71-104).

- [ ] **Step 2: Grant the creator ownership**

Still in `POST /api/projects`, after `Project.create`, add:

```ts
  await Grant.create({
    subject: user._id,
    relation: "owner",
    objectType: "project",
    object: project._id,
    createdBy: user._id,
  });
```

Without this a newly created board would have no owner at all — the creator is an instance admin and would still reach it, but nobody else could ever be granted access by a non-admin.

- [ ] **Step 3: Remove allowedProjects from the user model**

Delete the `allowedProjects` field from `src/models/user.ts` and from `IUser` in `src/types/index.ts`. Delete `allowedProjects: []` from `src/lib/pm/pm-user.ts:26`.

In `src/app/api/auth/me/route.ts:27`, replace `allowedProjects: user.allowedProjects || []` with:

```ts
    allowedProjects: (await accessibleProjectIds(user)) ?? [],
```

The response key stays — the frontend reads it, and it still means "the projects this session may open".

- [ ] **Step 4: Fix the two token-minting project pickers**

`src/app/oauth/authorize/route.ts:154` and `src/app/api/tokens/route.ts:41` both build a filter of projects the minting user may scope a token to. Replace each:

```ts
  const accessible = await accessibleProjectIds(user);
  const filter = accessible === null ? {} : { _id: { $in: accessible } };
```

Leave every `allowedProjects` field on `apiToken`, `oauthToken` and `oauthCode` untouched — those are scopes.

- [ ] **Step 5: Prove nothing references the removed fields**

Run: `grep -rn "allowedProjects" src | grep -v "apiToken\|oauthToken\|oauthCode\|models/apiToken\|models/oauthToken\|models/oauthCode\|auth/me"`
Expected: only hits inside token minting and the `auth/me` response key.

Run: `grep -rn "\.admins\|project.owner" src`
Expected: no output.

- [ ] **Step 6: Run the suite and build**

Run: `npx vitest run && npm run build`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(auth): drop project.admins and user.allowedProjects"
```

---

### Task 9: Live verification

The suite mocks Mongoose throughout, so it cannot prove the unique index exists, that the upsert actually upserts, or that login survives. This task is the one that does. **A green suite is not evidence for any of the claims below.**

**Files:** none. Do not commit code in this task; if it finds a defect, fix it in a task of its own.

- [ ] **Step 1: Bring the app up**

`.env.local` already exists and Mongo listens on 27017. Start with `preview_start {name: "claudeplanner-dev"}` (port 3456). Never start a dev server through Bash.

- [ ] **Step 2: Confirm the empty-collection state**

With no grants at all: log in as an instance admin — full access to every board. Log in as `boardadmin` (seeded, password `test123`) — the projects list must be empty and `/projects/TP` must 403, cleanly, with no stack trace in `preview_logs`.

- [ ] **Step 3: Grant through the UI and confirm it takes effect without a re-login**

As the instance admin, open `/projects/TP/settings`, set `boardadmin` to **Owner** and `plainuser` to **Member**. In `boardadmin`'s session, reload — the board and its Settings link must appear.

- [ ] **Step 4: Walk the matrix as each role**

As `boardadmin` (owner): edit the project name, open Board columns, add a webhook, open the members list. As `plainuser` (member): create and edit a task, create a sprint — then confirm `/projects/TP/settings` is refused and the Settings link is absent.

- [ ] **Step 5: Verify the index is real**

Mocked Mongoose cannot prove this. From a scratchpad script against `mongodb://localhost:27017/claudeplanner`, read `db.grants.getIndexes()` and confirm `{subject: 1, objectType: 1, object: 1}` is present **and unique**. Then attempt a second `insertOne` for a pair that already exists and confirm it fails with duplicate key 11000.

- [ ] **Step 6: Verify token minting end-to-end**

In the UI as `boardadmin`, go to `/settings/tokens` and mint a token scoped to TP. Confirm the project appears as a scopable option at all (this is `accessibleProjectIds` on the minting path). Then call `GET /api/projects` with that token: TP present, `canAdmin` **false** — a scoped token is never owner.

- [ ] **Step 7: Verify the instance admin's scoped token**

Mint a token scoped to TP as the **instance admin**. Call `GET /api/projects/TP/tasks` with it: must succeed. Call `PUT /api/projects/TP` with it: must 403. This is the regression the spec is built around; a failure here means `instanceAdminBeforeScope` is not reaching `decide()`.

- [ ] **Step 8: Write the results into CP-246**

Add a comment recording which paths were driven for real and which were synthesised, and paste the index output. State plainly anything not exercised.

---

## Self-Review

**Spec coverage.** Roles → Tasks 3-5. Permission matrix → Tasks 3, 4 (the two moves), 9 (walked live). Data model → Task 1. `check()` including the rule-3 trap → Tasks 1, 2, 9 step 7. Token scope is not a grant → Task 2 step 4, Task 8 step 4. What is removed → Task 8. No migration → Task 9 step 2 verifies the empty-collection state. API and UI changes → Tasks 4-7. Testing → per-task plus Task 9. `GET /api/projects` returning `canAdmin` already shipped in CP-245 and is re-pointed at grants in Task 3 step 4.

**Placeholders.** None: every code step carries the code, every verification step carries the command and the expected result.

**Type consistency.** `decide`/`principalOf`/`check`/`accessibleProjectIds` keep the same signatures from Task 1 through Task 8. `Need` is `"access" | "admin"` everywhere. `GrantRelation` is `"owner" | "member"` in the model, the API and `ApiProjectMember`. `accessibleProjectIds` returns `string[] | null` and every consumer handles `null` explicitly.

**Known gap, deliberate.** `withProjectOwner` turns a non-existent project into 403 rather than 404 for non-admins (Task 3 step 1). That is consistent with the existing `unresolvedProject` policy of not leaking which projects exist, and is noted so a reviewer does not read it as an accident.
