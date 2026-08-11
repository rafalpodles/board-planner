# Browser sessions on a server-side session cookie

**Date:** 2026-08-11
**Task:** BP-293
**Status:** agreed, rewritten after three rounds of independent security review

## Problem

The browser holds the user's password. `useAuthProvider` stores `btoa("username:password")` in
`sessionStorage` (`src/hooks/use-auth.ts:79`) and `useApi` replays it as `Authorization: Basic` on
every request. Base64 is an encoding, not a hash — anything that reads that key has the plaintext
password, and with it the ability to change the account's email, mint API tokens, or authenticate
anywhere the user reused it.

Two consequences follow.

**The user is logged out constantly.** `sessionStorage` is scoped to one tab and dies with it. A new
tab or a browser restart finds no credential, so `AuthGuard` redirects to `/login`. This is a
regression:

| commit | change |
|---|---|
| `25a28d4` *fix(auth): persist session across browser restarts* | `sessionStorage` → `localStorage`, explicitly to stop the re-login |
| `690adf4` *fix: address 17 security, performance, and correctness issues* | `localStorage` → `sessionStorage`, listed under "Security" in a bulk commit |

The second reverted the first. Its stated rationale was XSS exposure, but that reasoning does not
hold: with Basic Auth the stored credential *is* the password, so script running in the tab reads it
from `sessionStorage` just as easily. The change bought no security and cost the session.

**Every request re-verifies the password.** `getAuthUser` runs `User.findOne()` and `bcrypt.compare()`
on each call (`src/lib/auth.ts:147`), because a stateless credential must be checked from scratch
every time.

## Why not OAuth2 access + refresh tokens

The first three drafts of this spec issued browser sessions as `OAuthToken` rows with an access/refresh
pair and per-use refresh rotation, reusing the MCP machinery. Three independent security reviews
rejected it, each time in the same section. The defects were not prose errors; they came from two
structural choices, and are worth recording so the shape is not proposed again.

**Reusing the `OAuthToken` collection** forced a discriminator to separate sessions from machine
credentials — and the obvious one, `scope`, is attacker-controlled end to end: `/oauth/register` is
unauthenticated and `/oauth/authorize:45` takes `scope` free-form from the query string, so any
third-party app could have minted a token that cleared all five `viaMachineCredential` gates. Moving
to an explicit `kind` field then required a backfill on a collection holding live production
credentials (Mongoose does not apply schema defaults to query predicates, so a `kind: "machine"`
filter matches zero existing rows and would have killed the production MCP connection on its next
refresh), and left the cookie branch — the only path that grants `viaMachineCredential = false` —
able to accept a machine `cpat_` planted in the session cookie, reaching the same escalation by
another door.

**Per-use refresh rotation** generated a chain that never closed. `findOne` + `deleteOne` is a TOCTOU
that issues two valid pairs under concurrency; the grace window added to fix it cannot return the
current pair, because tokens are stored as `sha256` and that is one-way; rotating again instead
required pinning `previousRefreshTokenHash`, which makes the pinned hash replayable indefinitely —
a thief gets unlimited working pairs while the *victim* trips the revocation. Meanwhile a replay
outside the window matches no row at all, so there is nothing to attribute it to and nothing to
revoke.

The root mistake is importing a ceremony without the threat it defends against. Per-use rotation
exists because a **public third-party client** stores a refresh token somewhere it cannot protect. A
first-party httpOnly cookie is not that: script cannot read it. Likewise the access/refresh split
exists so a short-lived access token can travel to *resource servers* while the refresh token stays
with the client — but here there is one origin, and the cookie returns to the same server that issued
it. Both mechanisms cost their full complexity and bought nothing.

What this design keeps from OAuth2 is the part that was actually load-bearing: an opaque,
high-entropy credential stored only as a hash, with server-side revocation.

**The rotation TOCTOU is a real defect in the MCP path today** and is filed separately — it is not
introduced by this work and is not fixed by it.

## Model

A new collection, `src/models/session.ts`:

```ts
{
  tokenHash: String,            // sha256 of the cookie value, indexed, unique
  user: ObjectId,               // ref User, indexed
  expiresAt: Date,              // sliding; TTL index, expireAfterSeconds: 0
  absoluteExpiresAt: Date,      // hard cap, never extended
  createdAt, lastUsedAt: Date,
  userAgent, ip: String,        // for a future sessions UI; never used for authorisation
}
```

A separate collection rather than a discriminated `OAuthToken` is the point of the rewrite: with no
machine credentials in it there is no discriminator to get wrong, no legacy rows to backfill, no
polarity trap in any guard, and no way for a `cpat_` to be accepted as a session — a planted machine
token hashes to a value that is simply not in this collection.

The cookie carries `randomToken("cps_")` (`src/lib/oauth.ts:7`, 32 random bytes); only its `sha256`
is stored, matching how `cpat_` is handled at `token/route.ts:38`.

**Lifetime.** `expiresAt` slides 30 days from last use, **clamped to `absoluteExpiresAt`**
(`min(now + 30d, absoluteExpiresAt)`); the cap is 90 days from login and is never extended, so a
stolen cookie cannot be kept alive indefinitely by use alone. The clamp matters beyond tidiness: the
TTL index is keyed on `expiresAt`, so without it dead rows survive up to 30 days past the cap, the
cookie's `Max-Age` outlives the session, and cap enforcement rests entirely on an application-level
check that any future query could bypass.

**Sliding is throttled.** Extending on every request would write to Mongo on every API call. Extend
only when `expiresAt` is more than 24 h closer than the full window — at most one write per session
per day. `lastUsedAt` follows the same throttle.

## Endpoints

| Endpoint | Behaviour |
|---|---|
| `POST /api/auth/login` | JSON `{username, password}` → Origin check → lockout check → `verifyCredentials` → create session → `Set-Cookie` → return the user |
| `POST /api/auth/logout` | delete the row, clear the cookie — **not wrapped in `withAuth`**, or a 401 short-circuits before the cookie is cleared and an already-dead session can never be tidied from the browser |
| `GET /api/auth/me` | unchanged contract, now satisfied by the cookie |

There is no refresh endpoint, no rotation, and no client-side token dance. Expiry is server state, so
the failure mode that killed the previous design — the provider's bootstrap `fetch` in
`use-auth.ts:43-57` not participating in a refresh flow, silently ending every session one hour after
login — cannot occur here.

`POST /api/auth/login` **issues a fresh row and deletes nothing.** An earlier draft deleted the user's
prior row matching the same `userAgent`, for orphan hygiene. That would have been a bug: modern UA
strings are frozen and reduced, so two Chrome installs on the same OS version produce identical
values, and logging in at home would evict the work laptop and vice versa — reintroducing the exact
"logged out constantly" symptom this task exists to remove, and contradicting the model's own rule
that `userAgent` is never used for authorisation. Orphans are already handled by the TTL index. Login
does emit expiring `Set-Cookie` for legacy cookie names, so a rollout cannot leave a stale name riding
alongside the new one.

### Rate limiting

The lockout currently lives in `getAuthUser` (`src/lib/auth.ts:142-152`), where it covers *every*
Basic-authenticated request. Removing Basic shrinks that blanket to whatever is explicitly wired, so
it must be extracted into a shared helper and applied at all three places a password is verified:

- `POST /api/auth/login` (new)
- `POST /oauth/authorize` — `authorize/route.ts:193` calls `verifyCredentials` with **no throttle at
  all** today and re-renders the form on failure (`:194`). It is an unthrottled password oracle right
  now, and removing the Basic blanket leaves it fully exposed.
- `PUT /api/users/me/password` — `route.ts:45` compares the current password unthrottled.

The key stays `${clientIp}:${username}`. Three limitations, unchanged by this work but no longer
masked by breadth: the limiter is an in-process `Map` (`src/lib/rate-limit.ts:5`), so the lockout
divides by instance count under horizontal scaling; `getClientIp` returns `"unknown"` with no proxy
header (`auth.ts:17-23`), collapsing every key to `unknown:<username>` on a proxy-less deployment; and
because the key includes the username, **password spraying across many usernames from one IP is not
throttled at all**. A per-IP counter alongside the per-key one would close the last of these.

Note honestly that this work does not remove the password from the product surface:
`src/app/oauth/authorize/route.ts:193` still accepts it from a form. It removes it from *storage in
the browser*, which is the defect being fixed.

## Cookie

```
__Host-bp_session   httpOnly  Secure  SameSite=Lax  Path=/   Max-Age=<expiresAt>
```

**The `__Host-` prefix, not a narrow `Path`.** Production is `app.board-planner.com` and two marketing
front-ends share the registrable domain, so a compromised sibling subdomain can set a cookie with
`Domain=.board-planner.com` that the app cannot distinguish from its own — classic session fixation.
`__Host-` forbids `Domain` and forces `Path=/`, closing it. Path scoping was considered and rejected:
it buys almost nothing, since any XSS in the origin can call the endpoint itself, and it is mutually
exclusive with the prefix.

**Insecure mode is an explicit operator opt-in, never inferred from the request.**
`docker-compose.yml:19` defaults to `http://localhost:3000` and runs a *production* build over plain
HTTP, so keying on `NODE_ENV` would silently break a supported deployment: a `Secure` cookie over
`http://` is discarded with no error, login returns 200, and every later request 401s. But deriving
it from `x-forwarded-proto`/`x-forwarded-host` — the pattern at `src/lib/pm/mcp-oauth.ts:284-289` — is
worse: those headers are client-suppliable, so a request claiming `x-forwarded-host: localhost` could
make production accept an unprefixed cookie, and the localhost heuristic does not cover a self-host
reached by LAN address or hostname anyway.

Use an env flag, `COOKIE_ALLOW_INSECURE`. The application default is **off**: `Secure` + `__Host-`,
and **only the prefixed name is accepted**. With the flag on: no `Secure`, unprefixed name. The
accepted name is decided by the same condition as the attributes — never a `prefixed ?? unprefixed`
fallback, which would let a sibling subdomain's injected cookie be accepted on https.

Three details that decide whether this works or ships broken:

- **It is a runtime `environment:` entry in `docker-compose.yml`, not a build arg.**
  `NEXT_PUBLIC_APP_URL` sits under `build.args` (`docker-compose.yml:19`) because Next inlines it at
  build time; copying that placement would leave the flag unset at runtime.
- **Compose sets it on by default** — `COOKIE_ALLOW_INSECURE: ${COOKIE_ALLOW_INSECURE:-1}` — because
  `README.md:11` documents `docker compose up -d --build` as a supported one-command deployment and it
  binds localhost over plain HTTP. Leaving the app default (off) to apply there would ship a
  deployment where login returns 200, the browser silently discards the cookie, and every subsequent
  request 401s. `README.md` documents removing it once the instance is behind TLS.
- **Parse by exact match `=== "1"`**, and log a warning at startup whenever it is active. A
  `Boolean(process.env.COOKIE_ALLOW_INSECURE)` test would treat `"false"` and `"0"` as *on* — failing
  open, and because the same condition selects the accepted cookie name, silently accepting an
  unprefixed cookie on https.

**What httpOnly does and does not buy.** It stops credential *theft* — no script can read the cookie,
and the password leaves the browser entirely. It does **not** stop XSS from making authenticated
requests (session riding). Worth stating precisely rather than overselling.

### CSRF

`SameSite=Lax` withholds the cookie from cross-site `POST`/`PUT`/`PATCH`/`DELETE`; it rides only on
top-level GET navigation. The two-minute Chrome exemption applies only to cookies with *no* SameSite
attribute, so setting it explicitly avoids it.

One GET handler mutates: `src/app/api/pm/oauth/callback/route.ts:29` (`findOneAndDelete` plus
`project.save()`). It is unauthenticated by design (`:20-21`) and authorised by a single-use TTL-bound
`state`, so it carries no session cookie and the conclusion is unaffected — but the blanket claim "no
state-changing endpoint answers GET" is false and is not relied upon.

A second layer checks request provenance, **fail-closed**, on `POST`/`PUT`/`PATCH`/`DELETE`:

1. **`Sec-Fetch-Site` is the primary signal** — accept only `same-origin` and `none`. `none` marks a
   browser-UI-initiated navigation, which cannot be a mutating method; a form submission always
   carries an initiator, so a cross-site top-level POST to `/api/auth/login` arrives as `cross-site`
   and is refused.
2. **`Origin` is the fallback** when `Sec-Fetch-Site` is absent, compared against an explicit
   **`APP_ORIGIN`** env var (comma-separated allowlist), validated at startup.

Absence of both means a pre-Fetch-Metadata browser or a non-browser client, and non-browser clients
must use `Bearer` — so it is refused.

**Fetch Metadata headers are sent only for potentially trustworthy URLs, and that decides whether
`APP_ORIGIN` is optional.** `https://…` and `http://localhost` qualify, so the default
`docker compose up` (bound to localhost) gets the primary signal. A self-host reached over plain HTTP
at a LAN address or hostname — `http://192.168.1.10:3000`, `http://nas.local:3000` — **never** gets
`Sec-Fetch-Site` at all. Everything there falls to `Origin` vs `APP_ORIGIN`, and with `APP_ORIGIN`
unset the fail-closed rule refuses every mutating request **including `/api/auth/login`**, so the
instance cannot be logged into at all. That is the same shape as the `COOKIE_ALLOW_INSECURE` default
trap one section below.

Therefore: **`APP_ORIGIN` is required whenever `COOKIE_ALLOW_INSECURE=1`**, enforced by the same
startup validation that parses the allowlist — refuse to boot rather than serve an instance nobody can
log into. It gets its own runtime `environment:` entry in `docker-compose.yml` beside the flag, and a
row in the `README.md` options table.

**Provenance refusal returns 403, not 401.** A 401 would be indistinguishable to the SPA from a dead
session, and the client's `onUnauthorized` (below) converts a 401 into a full logout — so a
misconfigured `APP_ORIGIN` or an unusual client would destroy a live session instead of surfacing an
error.

`APP_ORIGIN` has to be its own runtime variable. The three tempting alternatives are all wrong, for
reasons this spec already established elsewhere: `NEXT_PUBLIC_APP_URL` is **build-time**
(`README.md:34`), so a self-hoster who builds the image and serves it behind a proxy at a real
hostname would compare against `http://localhost:3000` and 403 every mutation; `x-forwarded-host` is
client-suppliable and banned above for exactly this reason; and bare `Host` is attacker-set on a
directly-exposed deployment. Failing to pin this is the same defect class as deriving `Secure` from a
request header, one section earlier.

The check lives **inside `getAuthUser`'s cookie branch**, because four routes call `getAuthUser`
directly and bypass the middleware: `src/app/api/auth/me/route.ts:7`, `src/app/api/mcp/route.ts:21`,
`src/app/api/users/route.ts:34`, `src/app/api/projects/[projectId]/pm/chat/route.ts:29`. The Bearer
path stays untouched — machines do not send `Origin`.

**Four endpoints need the check applied explicitly**, since they never reach `getAuthUser`'s cookie
branch: `/api/auth/login`, `/api/auth/logout`, the bootstrap branch of `POST /api/users`
(`route.ts:30-38` authenticates only when `userCount > 0`, so on a fresh instance a cross-site form
post can seed the admin account), and `POST /oauth/register` (creates a junk client; low severity but
it is the fourth).

**Two further unauthenticated mutating POSTs must deliberately NOT get the check**:
`src/app/api/workers/enrolment/device/route.ts` and `.../device/token/route.ts`. The worker is a
non-browser client and sends neither `Sec-Fetch-Site` nor `Origin`, so fail-closed provenance would
break device enrolment outright. Stated explicitly because the list above otherwise reads as
incomplete and inviting an implementer to "finish" it. (`workers/register` is Bearer-gated by an
enrolment token and is not a CSRF surface.) Login is the serious one: it is unauthenticated, needs no cookie inbound and *sets* one
outbound, and `Set-Cookie` on a top-level navigation response is stored. Combined with
`request.json()` parsing regardless of `Content-Type`, a cross-site `<form enctype="text/plain">`
would otherwise sign the victim **into the attacker's account**, so everything they then write or
upload lands on the attacker's board. `SameSite=Lax` does not defend this direction.

A separate CSRF token is not warranted, but note the margin is thinner than it looks: because
`request.json()` ignores `Content-Type`, the defence stands on SameSite and Origin, not three legs.

## Request authentication

`getAuthUser` resolves in order:

1. `Bearer cpat_…` — OAuth access token → `viaMachineCredential = true`
2. `Bearer cp_…` — API token → `true`
3. **session cookie — looked up in `Session` by `sha256` → `false`**
4. otherwise `null`

No discriminator is needed anywhere: the collection is the discriminator, and `OAuthToken` is not
touched by this work. The matched row's `_id` is attached to the returned user so handlers can
identify the calling session (used by password change, below); add the field to `IUser`
(`src/types/index.ts:142-167`) beside `viaMachineCredential`. It cannot leak — `toJSON` serialises
schema paths only, `src/models/user.ts` is strict by default, and no handler returns the
authenticated document wholesale.

`getAuthUser(request: Request)` (`auth.ts:120`) and `AuthenticatedHandler` (`middleware.ts:14`) are
typed on the plain `Request`, which has no `.cookies`. The repo has **no cookie code anywhere** and no
root `middleware.ts`, so there is no local precedent: parse `request.headers.get("cookie")` directly,
keeping the signature and leaving every existing caller untouched.

Basic Auth is removed from this layer. Its consumers:

- remote MCP — already Bearer-only; `src/app/api/mcp/route.ts:19` returns before `getAuthUser` when
  there is no bearer token
- worker — `verifyWorkerCredential` on `x-worker-id` + Bearer (`middleware.ts:190`)
- stdio `mcp-server/` — prefers `BOARDPLANNER_TOKEN`; the username/password branch appears in no
  README, `.mcp.json` or deploy config. Drop it, including the error message at
  `mcp-server/src/index.ts:14` that is its only documentation.
- **the Playwright e2e suite — a real consumer.** `e2e/field-history.spec.ts:30`,
  `e2e/column-roles.spec.ts:31`, `e2e/instance-audit.spec.ts:152,174`, `e2e/run-conflict.spec.ts:45`.
  Most move to API tokens — `e2e/seed.ts:26` already seeds a `cp_` token straight into Mongo.
  **`instance-audit.spec.ts:174` must move to a cookie session instead**: it demotes an admin to
  member and asserts `GET /api/admin/audit` → 403, but with a `cp_` token that 403 arrives from
  `viaMachineCredential` (`admin/audit/route.ts:12`) *before* the role check, so the test would pass
  while no longer testing what it names. That particular assertion is a `GET`, so the provenance check
  does not apply to it — but Playwright's `APIRequestContext` sends neither `Origin` nor
  `Sec-Fetch-Site`, so every state-changing setup call in the suite must set one explicitly.

## Client

`useApi` stops setting `Authorization` at **all three** sites — `request` (`use-api.ts:23`), `upload`
(`:52`) and `stream` (`:82`, SSE). Cookies attach automatically: every URL is relative and `fetch`
defaults to `credentials: "same-origin"`. `getAuthHeader` is removed from `useAuth`.

There is **no refresh-and-retry logic** — no single-flight promise, no `/api/auth/*` exemption to
prevent a logout→401→refresh→logout recursion, no module cycle. That is the largest simplification the
architecture change buys.

But the client still needs to **notice** a 401, and this is a trap worth naming because the two
statements look compatible and are not. Today nothing observes response status outside the bootstrap
fetch: `useApi` throws (`use-api.ts:32-40`), and `AuthGuard` redirects only when `user` is null
(`AuthGuard.tsx:17-22`), which is set solely by `login`, `logout` and bootstrap
(`use-auth.ts:59-94`). A session dying **mid-session** would therefore leave the SPA rendered with
every call failing and no redirect until a manual reload — and that is guaranteed to happen: the
90-day absolute cap reaches it, and so does a password change on another device.

The fix is one hook, not the rejected machinery: `useApi` calls an `onUnauthorized()` from the auth
context on `res.status === 401`, which clears `user` and lets the guard redirect. No new module cycle
— `use-api.ts:3` already imports `use-auth`.

## Session revocation

Deleting a user's `Session` rows ends their sessions. Sites:

- `PUT /api/users/me/password` (`route.ts:50`) — currently just `record.save()`. Delete every session
  for that user **except the calling one**, identified by the row id `getAuthUser` now attaches. The
  handler returns a bare `NextResponse.json({ok:true})` today and needs no `Set-Cookie`, because the
  surviving session's cookie is still valid — an advantage of not rotating.

  Build the filter conditionally: add `_id: { $ne: sessionId }` **only if `sessionId` is set**. The
  route is reachable with a `cp_` or `cpat_` token, which has no session row, and writing
  `{_id: {$ne: undefined}}` unconditionally would leave correctness resting on Mongoose stripping
  `undefined` from the predicate.

That is the only site: `src/app/api/users/[userId]/route.ts:18-57` handles `role` alone, and role
changes need no revocation because `getAuthUser` re-reads the user on every request — the session
carries identity, not authority. `DELETE` on that route (`:59`) leaves rows behind, harmless (the user
is gone, so `getAuthUser` yields null) and reaped by the TTL; delete them anyway for hygiene.

This replaces the workaround at `src/app/(app)/settings/security/page.tsx:41`, which calls
`login(user.username, newPassword)` right after the change — that call must go, or the password
re-enters JS through the back door.

Machine tokens are deliberately **not** revoked on password change: it would silently break MCP
integrations that never saw the password.

## Removals and collateral

- `AuthedImage.tsx` — it exists only to attach an `Authorization` header to images
  (`src/components/ui/AuthedImage.tsx:12`). With cookies, `<img>` authenticates natively. It also
  provides a loading skeleton (`:51-53`) and an "unavailable" placeholder (`:41-49`); both call sites
  are `src/components/pm/PmChat.tsx:426,596`. **Decision: give both up.**
- **Caching.** `src/app/api/uploads/[fileId]/route.ts:53` sends
  `Cache-Control: public, max-age=31536000, immutable` on a `withAuth` route. That is safe today only
  by accident: RFC 9111 §3.5 forbids shared caches from storing responses to requests carrying
  `Authorization`. Once the credential is a cookie that protection is gone and any CDN may store a
  private attachment and serve it anonymously for a year — and removing `AuthedImage` routes these
  through plain `<img>`, where caching is most likely. The reasoning generalises past this one route,
  so: flip it to `private`, **and** add a blanket `Cache-Control: private, no-store` plus
  `Vary: Cookie` for `/api/:path*` as a second entry in the existing `headers()` block at
  `next.config.ts:19-31`. Doing both is deliberate: whether a config header or a route-handler header
  wins varies by Next version, and belt-and-braces is safe under either precedence. `Vary: Cookie` is
  redundant alongside `no-store` but harmless. Streaming is unaffected — the worker SSE route keeps
  its own headers and the PM chat SSE is a POST, uncacheable regardless.

  Product consequence to expect: with `AuthedImage` gone and `no-store` applied, PM chat images
  refetch on every mount and no longer show a loading skeleton, so brief flashing is likely. Not a
  security issue; flagged so it is not mistaken for a bug in review.
- `getAuthHeader` from `useAuth` and its consumers, including the note at
  `src/app/(app)/settings/security/page.tsx:39`.
- `parseBasicAuth` from the request path.
- The `RateLimitError` catches, dead once the lockout moves to login — three places, not one:
  `src/app/api/auth/me/route.ts:8-13`, `src/lib/middleware.ts:27-32`,
  `src/app/api/projects/[projectId]/pm/chat/route.ts:30-34`.
- Any `auth_credentials` found on load is deleted from **both** `sessionStorage` and `localStorage`.
  Commit `25a28d4` stored it in `localStorage` for twelve days; a cleanup that only clears
  `sessionStorage` leaves a plaintext password on every machine used in that window, permanently. The
  password is **not** migrated into a session.
- `worker/src/scrub.ts:24` — `cpw?_[a-fA-F0-9]{32,}` does **not** match `cpat_`, `cprt_`, `cpac_` or
  `cpct_` (after `cp` comes a letter that is neither `w` nor `_`), so OAuth tokens already leak past
  the scrubber unless preceded by `Bearer`. Sessions add `cps_` and a new carrier: the `Cookie:` and
  `Set-Cookie:` headers.

  The replacement must be **`cp(?:w|s|at|rt|ac|ct|c)?_[a-fA-F0-9]{32,}`** — note the optional group.
  An earlier draft of this spec proposed `cp(s|at|rt|ac|ct|c)_…`, whose group is mandatory and has no
  `w` branch, which would have *stopped* scrubbing `cp_` (API tokens) and `cpw_` (worker credentials)
  — the only two prefixes the current pattern catches. A fix for a leak that creates a leak. Add a
  regression test asserting all eight prefixes redact: `cp_`, `cpw_`, `cps_`, `cpat_`, `cprt_`,
  `cpac_`, `cpct_`, `cpc_`.

## Consequences

- A session survives 30 days of inactivity, capped at 90 days total.
- `bcrypt.compare()` runs once per login instead of once per request.
- Password change gains the ability to revoke, for the first time in this system.
- `OAuthToken`, `/oauth/*` and the MCP path are untouched — no migration, and nothing to revoke.

## Testing

`src/lib/auth.ts` has **no test file today** — the `getAuthUser` tests below are greenfield, including
the `User`/`Session` mocking harness.

- `getAuthUser`: a valid session cookie resolves with `viaMachineCredential === false` and attaches the
  row id; `cpat_`/`cp_` yield `true`; a `Basic` header is rejected.
- **Escalation regression:** a machine `cpat_` placed in the session cookie is rejected — it is not in
  the `Session` collection. This is the defect that killed the previous design; it should be
  impossible here by construction, and the test pins that.
- A browser session reaches all five `viaMachineCredential`-gated endpoints (worker kill switch,
  `/api/admin/audit`, three enrolment routes).
- Login: correct credentials set the cookie with the expected attributes; wrong credentials record a
  failed attempt and lock out at the existing threshold; `/oauth/authorize` now locks out too.
- **Login CSRF:** cross-site `Origin`, and absent `Origin`, are both rejected before any credential
  check. Same for `/logout`.
- **Cookie mode:** with `COOKIE_ALLOW_INSECURE=1` the cookie is set unprefixed and without `Secure`
  and the session works; without it, an unprefixed cookie is refused even when present, and
  `x-forwarded-proto`/`x-forwarded-host` do not influence either decision.
- **Flag parsing:** `"false"` and `"0"` leave secure mode **on**. A `Boolean()` implementation passes
  the happy path and fails this one — it is the whole point of the test.
- **Provenance:** `Sec-Fetch-Site: same-origin` passes; `cross-site` is refused; with the header
  absent, `Origin` is matched against `APP_ORIGIN` and a mismatch is refused; with both absent the
  request is refused. `x-forwarded-host` does not influence the comparison.
- **Mid-session death:** a request that 401s after the session is revoked server-side clears `user`
  and redirects, rather than leaving the SPA rendered with every call failing.
- **Login issues a fresh row and deletes nothing:** two logins with the same `userAgent` leave two
  live sessions, both working.
- **Clamp:** a session near its absolute cap does not slide past it, and its `expiresAt` never exceeds
  `absoluteExpiresAt`.
- **Scrub:** all eight prefixes redact — `cp_`, `cpw_`, `cps_`, `cpat_`, `cprt_`, `cpac_`, `cpct_`,
  `cpc_` — plus `Cookie:`/`Set-Cookie:` headers. The `cp_` and `cpw_` cases are regressions against a
  proposed pattern that would have dropped them.
- Expiry: a session past `expiresAt` is refused; a session past `absoluteExpiresAt` is refused even
  with recent use; sliding extends at most once per throttle interval.
- Logout deletes the row and clears the cookie, and clears it even when no row matched.
- Password change revokes other sessions, spares the caller's, and leaves `OAuthToken` rows untouched.
- Concurrency: N simultaneous authenticated requests on one session produce at most one expiry write
  and no errors — the case that made the previous design unworkable, now trivial because reads do not
  mutate.
- `src/lib/middleware.test.ts:47` and `middleware.worker-credential.test.ts:177` use `Basic abc` but
  are *negative* fixtures asserting 401, so they keep passing; update for accuracy, not necessity.
- **Both suites must run**: `npm test` at the root does not cover `worker/`, and the `scrub.ts` change
  lives there. Baseline before this work: 1333 root, 685 worker.
- End-to-end through the UI per the repo's verification rule: log in, close the tab, reopen the board,
  confirm no login prompt; log out and confirm the cookie is gone; confirm a PM chat image renders.

## Deliberately out of scope

- **Token binding** to IP or user-agent for authorisation. Mobile networks change addresses, which
  would reproduce the symptom this work removes. `userAgent`/`ip` are stored for display only.
- **A sessions UI** ("log out everywhere", list active sessions). The model now supports it directly —
  worth a follow-up.
- **Audit logging of login and logout.** Cheap and desirable, but separable.

## Pre-existing defects found during review, not fixed here

Each is live today and independent of this work. Separate tasks:

- **`/oauth/token` refresh rotation is a TOCTOU** (`route.ts:103-114`): `findOne` + `deleteOne` lets
  two concurrent refreshes both succeed and issue two valid pairs, and the old row is deleted before
  the new one exists, so a lost response strands the client. Affects the production MCP connection.
- `src/app/api/uploads/[fileId]/route.ts:29-34` performs **no ownership check** — any authenticated
  user can read any attachment by `fileId`.
- `src/app/api/oauth/connections/route.ts:38-42` passes `id` from `request.json()` into
  `findOneAndDelete({_id: id, user})`; a Mongo operator object deletes an arbitrary row of the
  caller's own.
- `getClientIp` (`auth.ts:17-23`) returns `"unknown"` without a proxy header, so a proxy-less
  deployment collapses every lockout key to `unknown:<username>` — a 10-attempt targeted denial of
  login, which matters more once the lockout stops being blanket.
