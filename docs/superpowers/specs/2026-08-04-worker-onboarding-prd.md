# Worker onboarding — from seven steps to one screen

**Status:** proposed, revised after review, then redirected — the repository now belongs to the
project and the machine clones it, rather than the machine's checkout defining the project
**Raised by:** rpo, after walking the current setup as if new
**Related:** CP-158, CP-161, CP-232 (shipped), CP-229 (reopened by this), CP-230

---

## The problem

Connecting a worker today takes seven steps across three surfaces, and the person doing it needs a
terminal. In order: write `repos.json` by hand with the right file mode, set the project's
repository, create a project-scoped API token, mint an enrolment token, export four environment
variables, run `node dist/main.js` from a cloned repository, then return to the browser to enable
the project.

That is not an onboarding. It is the author's own runbook, and it is the reason this cannot be shown
to anyone outside the machine it was built on. A demo currently begins with "give me your terminal
for twenty minutes".

The menubar app does not help, because it only **observes** a worker that is already running. It
cannot start one, cannot configure one, and shows "Can't reach the worker" until somebody has
already done the seven steps. Installing it and expecting a working worker does not work, and that
is exactly what a new user will try.

## What we are aiming at

> Open the app. It says *register a worker*. Choose where the worker's checkout lives. Click
> *connect to Board Planner*. The browser opens, you approve the project and choose how much
> autonomy it gets. You come back to the app and the worker is registered and running.

One screen in the app, one page in the browser, no terminal, no tokens copied by hand.

---

## What already exists

Worth stating plainly, because most of the machinery is built and this is more assembly than
invention.

| Piece | State |
| --- | --- |
| Single-use, expiring enrolment token | **built** — exactly the exchange primitive a device flow needs |
| `POST /api/workers/register` taking it | **built** |
| OAuth with authorize/token/register, PKCE, consent | **built, but the wrong precedent** — see below |
| Worker reports checkouts, server matches by remote | **built** (CP-232) |
| Per-project policy, `autoMerge` off by default | **built** (CP-232) |
| Menubar app, socket client, preferences, **`repos.json` writer and folder picker** | **built** |
| The worker itself | **zero runtime dependencies**, `dist` is 200 KB |

That last row cuts the other way from how the first draft used it. Preflight requires `npm`, and
`npm` means Node — so **any machine that passes preflight already has a runtime**. Bundling and
signing one, which was phase 4's expensive half, is self-contradictory. Ship the 200 KB and use the
Node that is already there.

## What does not exist

1. Any way for the app to obtain a credential without a human copying one.
2. Any way for the app to **start** the worker. Writing `repos.json` already exists —
   `CPMenubarCore/ReposFile.swift` writes it atomically at `0600`, and the Repositories tab already
   has an `NSOpenPanel` picker. Corrected after review; the first draft claimed otherwise and made
   phase 3 look larger than it is.
3. **Gate selection**, which turns out to be one boolean rather than a subsystem — see below.
4. Any check that the machine can actually do the work.
5. A signed, distributable application.

### The OAuth precedent is not the one to copy

The first draft called the existing OAuth implementation a usable precedent. It is not, and the
reason costs real time. **This app has no server session and no cookies** — browser auth is Basic
credentials in `sessionStorage`. That is exactly why `oauth/authorize` is a hand-rolled HTML page
carrying its own username and password form: it had no session to lean on.

Copying it means rebuilding a bespoke login form for the approval page. The cheaper precedent is the
one enrolment already uses: an ordinary React page behind `AuthGuard`, calling a route guarded by
`withAdmin` plus the `viaMachineCredential` refusal. Reusable from OAuth: the token helpers and the
TTL index on the code model, roughly twenty lines.

One consequence to design around either way: **`sessionStorage` is per-tab and is not inherited by a
tab opened from another application**, so the approval page will ask for a login even when the user
is signed in elsewhere. Unavoidable without adding cookies; worth stating rather than discovering.

### Gate selection is one boolean, not a phase

Two of the three presets are `autoMerge`, which already exists. The third — "write code, no review"
— is a single flag skipping `reviewGate`. What that does need is a **cross-field rule the current
validator has no notion of**: every field is checked in isolation, so nothing would stop
`autoMerge: true` with review disabled. The server must refuse that pair, and the worker must refuse
it too rather than trusting a policy it was handed — it is the one safety property the README
asserts outright.

### The dependency nobody has written down

The worker shells out to four binaries and checks for none of them at startup:

- `git`
- `npm`
- **`claude`, logged in** — on a CLI subscription session. An API key makes every run bill per token.
- **`gh`, authenticated** — it pushes branches and opens pull requests as that identity.

A new user with none of these installed will get a worker that registers, appears healthy in the
fleet console, claims a task, and fails it. **Preflight is not polish; without it the promised
"install and it works" is false on most machines.**

---

## The flow

### In the app

**1. Register a worker** — the only thing an unconfigured app offers.

**2. Preflight.** Before asking for anything, check the four binaries, that `claude` has a session,
and that `gh` is authenticated. Each failure gets a plain sentence and a way to fix it. Nothing
proceeds until they pass, because everything after this would be a worker that cannot work.

Once a project is chosen, preflight **proves it can fetch the repository by fetching it**. This is
the single biggest reason to prefer this direction: an authentication failure that would otherwise
appear after the first task, as an unreadable gate error, appears here instead, where it can be
named and fixed.

**3. Choose where work happens.** A native directory picker, but for a **parent folder** — "where
should workers keep their checkouts?" — not for an existing clone. Easier to answer, and it does not
assume the person has already cloned anything.

Anyone who *has* already cloned it gets a second path: **use an existing checkout**, verified the
same way, for the monorepo nobody wants a second copy of.

The human still chooses the location, on their own machine, so the property CP-232 established holds
— the app is acting for the person at that keyboard, not for the server.

**4. Connect to Board Planner.** The app asks the server to begin an enrolment, receives a short
code and a URL, and opens the browser.

### In the browser

**5. Approve.** The page shows the machine, and asks which project it should serve — a list of the
projects this operator can administer.

An earlier draft had the app send the remote it found and the page confirm the matching project.
That inverts ownership: the project's identity would come from whatever a laptop happened to have
checked out. It survives one user and breaks on the second, who cloned over https, or works on a
fork, or has a mirror. **The project owns its repository; the machine is told which one to fetch.**

**6. Choose the flow.** Three presets, worded as autonomy rather than as gates:

| Preset | Behaviour |
| --- | --- |
| **Write code** | agent works, static gates and build/test run, pull request opened, **no review gate** |
| **Write and review** | as above plus a second model reviewing the diff — *today's behaviour, and the default* |
| **Write, review and merge** | as above and the worker merges its own pull request |

Presets, not a gate checklist. The checklist can exist behind "advanced" in project settings, but
the onboarding question is *how much do you trust it*, not *which of six gates do you want*.

**7. Done** — the browser says it can be closed.

### Back in the app

**8.** The app has been polling; it receives **the worker credential** — issued as the last step of
the approval, not copied from a settings page — stores it, clones the repository into the chosen
folder, writes `repos.json`, starts the worker and registers it as a login item. The panel shows a
registered, idle worker.

`repos.json` remains where the configuration lives, but it stops being something a human authors. A
fresh install starts empty and the app fills it in.

---

## Two things the redirection settles

### The repository belongs to the project, as one field

`githubRepo` cannot simply be deleted: it has a second job, driving `github/sync` and `gitlab/sync`
for pull-request linking. The worker was only borrowing it.

What is actually wrong with it is that it is **provider-specific, and there are two of them**.
`githubRepo` and `gitlabRepo` are **decided: they merge into a single repository URL.** GitHub stops
being privileged in the settings screen, Bitbucket stops being a special case, and the worker gets
one thing to fetch. It carries a data migration and touches `github/sync` and `gitlab/sync`, so it
lands before the enrolment work rather than during it.

### Private repositories are already solved for GitHub, and provable elsewhere

The worry that killed this direction in the first draft turns out to be small. **The worker already
requires an authenticated `gh`** — it cannot push a branch or open a pull request without one — so a
private GitHub repository is covered by a dependency that has to be there anyway.

GitLab and Bitbucket go through the operator's own git credentials: an SSH agent, or a credential
helper. The worker runs as that person, so if they can clone by hand, it can clone. And preflight
does not have to assume — it clones, and reports what happened.

### A worker needs its own identity

`Comment.author` is a required reference to a user, so **today a worker comments in the voice of
whoever owns its API token**. Its notes on a task look as though a person wrote them. That is a
falsified audit trail, not a cosmetic problem, and it gets worse the moment a second person connects
a machine.

Give each registered worker a non-loginable user record, displayed as its owner's worker. Mentions,
filters, avatars and history keep working with no change to any consumer.

This does not foreclose SPIFFE or anything like it later: that would be the *authenticating*
identity, a layer underneath the *displayed* one. Choosing this now costs nothing there.

### The approval page stays an approval

It is tempting to put every setting on it, since the user is right there. Resist it. A page that
configures ten things is a settings screen wearing an approval's clothes, and people click through
those without reading — which is the exact opposite of what an authorisation screen is for.

**Decided: three decisions on that page** — who is connecting, which project, how much autonomy.
Everything else lives in project settings, one click away, afterwards.

## Settled by interview

Seven decisions, taken deliberately rather than left to whoever implements first.

**A worker must be able to push, and preflight proves it.** The worker pushes to `origin` with
`--force-with-lease` and has no concept of a fork. So read-only access is a hard failure — and today
it fails *late*, after the agent has done the work and passed six gates. Preflight verifies write
access and refuses to connect without it. Forks stay unsupported; adding them means a second URL and
a rewrite of delivery, for a case nobody has yet.

**The worker gets its own clone.** Not the operator's checkout. Today the worker registers worktrees
inside the working copy a human is also using and reaps directories beside it — a hazard that has
already bitten once in this repository. A dedicated clone in the chosen folder removes it, along
with the questions it dragged in: no picking a package inside a monorepo, no interference from
uncommitted work or a switched branch. "Use an existing checkout" is dropped, not deferred.

**A changed repository URL is followed, not fatal.** The server sends the URL with the assignment;
a worker whose `origin` differs re-points it, fetches, and re-verifies push. Success means it keeps
working with nobody involved; failure is reported as a binding error and it stops claiming. Renames
redirect anyway, so this covers the common case silently and the uncommon one loudly.

**One identity per machine, named for its owner.** `Comment.author` is a required user reference, so
today a worker comments *in the voice of whoever owns its API token* — a falsified audit trail, not
a cosmetic issue. Each registered worker gets a non-loginable user record, "Rafał · MacBook". Two
machines are two identities, because when something goes wrong the question is which machine. The
PM agent's `pm` user is the precedent. SPIFFE later would sit underneath this as the *authenticating*
identity; this is the *displayed* one, and choosing it now costs nothing there.

**A worker claims a task by assigning it to itself, and never touches an assigned one.** This is the
concurrency answer and it solves a second problem for free: a task parked for a colleague is
assigned, therefore untouchable. It needs two changes — the claim must set `assignee`, and the claim
filter must exclude tasks that have one. It also makes true what `CLAUDE.md` has always claimed and
the code never did.

**Every path back to the board clears that assignment.** Usage limit, crash, timeout, expired lease,
operator stop. Without this the rule above kills tasks silently: a task left assigned to a machine
that is no longer running it is a task **no worker will ever pick up again**.

**Registration is incomplete until the repository works.** Cloning and the push check can only
happen once a project is known, which is after approval — so the credential exists before the
repository is proven. The worker therefore registers in a *configuring* state, shown as such and
claiming nothing, and either completes or fails with a reason. There is never a worker that looks
ready and is not.

## Settled second round

**A machine that already has a worker is detected, and the operator is asked.** Adding another
project to the same machine is the common case and should cost only a project choice. The other two
answers — replace this worker, or register a second one — are offered explicitly. Today a repeated
registration silently overwrites the credential and kills the running worker.

**Clones live at `<chosen folder>/<project key>/`.** The key is disabled in the settings UI, so the
directory name will not start lying — though the API still accepts a key change, which is worth
either closing or handling. The known cost of keying on the project rather than the repository:
**two projects sharing one repository get two identical clones.** Accepted; detect it and say so
rather than pretending it did not happen.

**The worker identity is visible where authorship matters and hidden where people are managed.** It
appears as comment author, as assignee and in history — that is the entire point. It does not appear
in the user list for invitations, permissions, or a human picking an assignee. That makes it a
distinct kind of account rather than an ordinary user with an odd name, and keeps the user list from
becoming half machines once a team connects five.

**Rate limiting waits.** After a worker takes only unassigned tasks it can no longer eat a column
meant for people, so the remaining reason for a cap is the token bill — and nobody has seen that
number yet. Set it against a real figure rather than guessing one now.

## Design decisions

**Device flow, not a pasted token.** The app initiates and the browser approves, which is RFC 8628's
shape and the repo's existing OAuth shape. The alternative — keep pasting the enrolment token — is
cheaper by a day and keeps a step whose entire purpose is to be removed.

**Delete `CP_API_TOKEN` rather than auto-minting it.** The first draft proposed having enrolment
mint the operational token too, and justified it with "the operational credential must remain unable
to lift the kill switch". **That test does not discriminate**: the kill switch is guarded by
`viaMachineCredential`, which `auth.ts` sets for *every* API token, scoped or not. Scoping is
irrelevant to it.

Worse, the two do not compose. A worker's grant is **dynamic** — recomputed every heartbeat from the
checkouts it reports crossed with every enabled project. A project-scoped API token is a **static
list fixed when it was minted**. Enable a second project and the worker is assigned it on its `cpw_`
credential while its `cp_` token cannot write there: `claim` travels on the worker credential, but
`setStatus`, `comment` and `release` travel on the API one. The task claims, the report 403s, and it
sits in the active column until its lease expires. Silently, to the second project every user adds.

The fix is to remove the second credential entirely. `POST tasks/claim` is already `withWorker` and
re-derives the grant on every call; extending that to the four routes the worker actually uses gives
it **one credential whose scope tracks its assignments by construction**. More server work than
minting a token, and the only version that survives a second project.

**The app writes `repos.json`; the server still never reads a path.** Every property from CP-232
holds. The app is acting for the human at that keyboard, not for the server.

**Preflight is a resolver, not a check.** Finding the binaries is not enough. The worker builds
every child environment from an allowlist that takes `PATH` from its own process, and a process
started by launchd has `/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew, no nvm. An app launched from
Finder has the same minimal `PATH`. So preflight can find `claude` through a login shell, pass, and
then spawn a worker that cannot see it: **preflight green, every task failing.** Preflight must
therefore produce absolute paths, persist them, and inject them into the spawned worker.

It must also check what the gates need: a lockfile and both a `build` and a `test` script, because
`npm ci` and `npm run build` are unconditional. A Python or Go repository fails the build gate on
every task, forever. That filters more first users than the four binaries do.

**Preflight before enrolment, not after.** A machine that cannot run the work should never appear in
the fleet console as a healthy worker.

## Deliberately out of scope

**"Flow depending on the type of task."** The most attractive idea in the original sketch and the
one to defer. It adds a dimension to policy resolution (project → category → effective) and
multiplies the configuration surface before anyone knows which categories actually want different
treatment. Revisit when a real case appears, which the presets will surface.

**Windows and Linux.** The app is SwiftUI and macOS-only. The worker is portable; the onboarding is
not, and pretending otherwise designs for a user who does not exist yet.

**Self-service enrolment by non-admins.** Enrolment tokens are mintable only by an instance admin in
an interactive session, and CP-232's recorded decision — that a worker's grant is instance-wide —
rests on exactly that. Changing who can enrol changes that calculus and is its own piece of work.

---

## Risks

**Code signing and notarisation is the real cost, and it is not code.** An unsigned app is blocked
by Gatekeeper on any Mac but the one that built it, which is the entire point of the exercise. It
needs an Apple Developer account, a signing identity, and notarisation in the build. Everything else
here can be built and tested locally; this one cannot.

**CP-230 stops being cosmetic.** The worker does not exit after `SIGTERM`. As a hand-run process
that is an annoyance. As a login item it means every restart waits out a timeout and is killed —
visible, and on the path this design puts every user on. It should land before or with this.

**The app spawning a process** brings sandboxing and login-item registration, neither of which the
current app does. `SMAppService` is the modern path.

**A device code is a credential.** Short-lived, single-use, bound to the request that created it,
and approving it must require an authenticated session. The existing `oauthCode` model — `used`,
`expiresAt`, a TTL index — is the shape to copy.

---

## Phases

Reordered after review. The original had a phase too small to be a phase, and put the two cheapest,
highest-value fixes last.

**Phase 0 — make the worker survivable as a background service.** Two small pieces, both local, both
useful to the deployment that exists today:

- **CP-230.** The loop parks in `sleep(pollIntervalMs)` — a bare `setTimeout`, no abort — so a stop
  waits out the poll interval. At the default 30 s against launchd's 20 s exit timeout, a login-item
  restart is not *sometimes* killed, it is **always** killed, and raising the interval to save quota
  makes it worse. Ten lines.
- **Worker-side preflight**, reported on the heartbeat alongside `bindingError`. Fixes "healthy in
  the console, fails every task" for the current deployment, and is exactly what the app's preflight
  screen will later render.

**Phase 1 — device enrolment, presets folded in.** The endpoints, the approval page, the single
credential. Gate selection is one boolean and rides along rather than being its own phase. **Decide
the browser-session question before starting**: an ordinary React page behind `AuthGuard` (cheap,
matches the codebase) or a hand-rolled login page (expensive, matches OAuth).

**Phase 2 — the app's first run.** Preflight as a resolver, the picker wired to the flow, spawning
the worker, `SMAppService` as a login item. Exercise `SMAppService` **during** this phase on the
build machine — the PATH and login-item behaviour only appear in that configuration, and discovering
them in phase 3 is discovering them behind a signing blocker.

**Phase 3 — signing and distribution.** Signing the Swift app, notarisation, an installer. Blocked on
an Apple Developer account, not on us. Smaller than first drafted, because no Node runtime ships.

A demo becomes possible at the end of phase 2 on a machine we control, and at the end of phase 3 on
anyone's.

---

## Answers the first draft owed

Raised by review; each needs a decision, not a paragraph.

**Several projects match one remote.** `assignmentsFor` emits an assignment for *every* enabled
project whose repository matches, and both share one worktree root. The approval page says "the
project" in the singular and has nothing for this. Decide: approve one and leave the rest, or list
them.

**A remote matching no project.** The fallback "pick from a list" does not work as written — matching
is purely on the project's repository field, so choosing from a list yields no assignment unless the
server also *writes* `githubRepo` from what the app reported. Either say it does, and reckon with a
project write happening from a device approval, or drop the fallback.

**A checkout with no `origin`**, or whose remote is named `upstream`, is silently dropped from the
inventory. The worker registers, looks healthy, is assigned nothing, and says nothing.

**A machine that already has a worker.** Registration upserts on name and host and overwrites the
credential, so running onboarding twice kills the running worker; under a different name it creates
a second row that quietly starves. The flow must detect an existing identity and offer reuse,
replace, or a second worker.

**Picks that `bindRepository` will refuse** — a symlinked path, a package inside a monorepo rather
than its toplevel, a group-writable directory, a repository with certain local git config. Every one
is a plausible first pick and today surfaces only as a string in the fleet console. These checks
belong in the picker, in the same plain-sentence style as preflight.

**Nothing is resumable.** Writing `repos.json`, obtaining a credential, spawning, registering a login
item — four steps with no state machine. Browser closed, code expired, approval denied: `repos.json`
is already written and the app is in an unnamed state.

**Which account `claude` is logged into.** Preflight can see a session exists, not whose. The whole
cost model depends on it being the subscription and not an API key.

---

## Also out of scope, with one correction

**Per-task-type flows** stay deferred as *policy resolution per category*. But review is right that
half of it is load-bearing and cheap: **which tasks a worker may claim at all.** Today the last click
hands the agent the entire approved column, sorted by order, with no filter by assignee, size or
category. For the first run of a new install — the demo this document exists to enable — that is the
wrong first move. A single project-level predicate is what makes it safe to show anyone.

**Windows and Linux** stay out, but the contract needs protecting: the worker must keep working from
its launchd plist and environment variables. The app is a convenience *over* that contract, never a
replacement, or the portable path rots while nobody is watching.

**Non-admin enrolment** stays out, and the reasoning matches the code exactly.

---

## Housekeeping this turned up

`worker/README.md` still says `CP_API_TOKEN` "must belong to an instance admin" and is "spent once,
to register" in one section, while another section — and the code — say registration uses the
enrolment token and `CP_API_TOKEN` is the ongoing operational credential. Whoever implements this
will read the wrong half.
