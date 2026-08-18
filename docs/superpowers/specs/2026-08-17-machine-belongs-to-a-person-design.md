# A machine belongs to a person

Design, 2026-08-17. Tracked as BP-358. Supersedes the routing half of the worker model: a machine stops being an
interchangeable server for a project and becomes one person's computer.

## The problem

Today nothing connects a machine to a human. `Worker` has no `owner` field. The person who
connected it survives in exactly two places, neither of them usable by the claim: the display name
of the machine's own account (`"Rafal · laptop"`), and `approvedBy` on the enrolment record — which
names the admin who approved, not the owner.

Routing keys instead on `project.worker.claimAssignee`, a single nominated user for the whole
project. Every machine approved for that project races for tasks assigned to that one person; the
claim is an atomic `findOneAndUpdate`, so two machines never take the same task, but which machine
wins is a race nobody can steer. `claimScope: "any"` widens it further to unassigned tasks.

Three consequences:

1. **Assigning a task to yourself does nothing** unless you happen to be the project's nominee.
2. **A colleague's task can run on your Mac.** Once an admin approves your machine for a project,
   it is a candidate for every task in that project.
3. **The person choosing the agent and the person whose machine bears it can be different people.**
   This is what made BP-345 a security problem rather than a preference.

The enrolment screen already promises the model that does not exist: *"The machine acts under this
account."*

## What this changes

### `Worker.owner`

A real `ObjectId` ref to `User`, set at enrolment from the account that is connecting — the person
who registered the machine, never an admin standing in for them. This makes the sentence on the
enrolment screen true.

**Amended during implementation: admin approval of a machine goes away entirely.** Under the old
routing a machine took work assigned to a project-wide nominee — anyone's work — so admitting a
machine to the instance was an instance-level decision and an admin was the right gate. A machine
now runs only its owner's own work, on its owner's own hardware, entirely inside permissions that
person already holds; the approval step signed off on something already permitted.

So enrolling is self-service, in both the device flow and the enrolment-token flow, and the person
enrolling is the owner. The projects a machine may serve are the projects its owner can reach,
resolved live rather than stored as a per-worker list — so `approvedProjects` and `isApprovedFor`
go with the approval, and a revoked grant reaches the machine on its next poll. An instance admin
keeps visibility and the kill switch — the fleet console and `enabled`/`lockedByInstance` stay —
but stops being a required step.

The enrolment screen's "How much should it do on its own?" presets go too: they wrote
`project.worker.agent`, which after this design decides only which agent the task picker offers
first, so an enrolling person would have been changing a project-wide suggestion for everyone from
a screen about their own laptop. Committing a project to machines stays an instance-admin decision
with its own audit row — the same rule `PUT /api/projects/:id` applies — taken from the enrolment
only when the person confirming could take it anyway.

`Worker.identity` — the auto-created `worker-<id>` account with `kind: "machine"` — stays untouched.
The two answer different questions: `identity` is *which machine did this* in the audit trail,
`owner` is *whose machine is this*. Both are needed.

### Routing keys on the owner

The claim filter takes tasks whose `assignee` is the machine's `owner`, in place of the project
nominee. An unassigned task belongs to nobody, so no machine has grounds to take it.

### `Task.assignedBy`

An `ObjectId` ref to `User`, written whenever `assignee` changes. Without it there is no way to tell
"I assigned this to myself" from "somebody assigned this to me", and that distinction is the whole
consent model.

### An agent is the hand-over

Assigning a task to yourself means *I am working on this* — it does in every tracker, and it has to
keep meaning that. So it cannot also mean *my computer is working on this*. The gesture that hands
work to a machine is **choosing an agent**:

- **no agent** — a person does it. No machine touches it. This is the ordinary case and the default.
- **an agent** — the owner's machine takes it, and runs that agent.

The field stops answering *how* and starts answering *whether, and how*.

Three consequences, all of them required rather than optional:

1. **The empty option has to be renamed.** It reads "Project default" today, which is honest about
   what it does — clearing the field falls back. Under this model it means *nobody*, and the label
   has to say so ("No agent — I'll do it myself"). Renaming it before the behaviour changes would
   make it a lie.
2. **The project's default agent changes role**, from the thing that runs when a task names none to
   the thing the picker offers first. It stops being a mechanism and becomes a convenience.
3. **The fallback chain in `snapshotFor` goes.** Today it is task agent → project default → the
   seeded "Default", and the comment explains why: without it, projects that had a worker before
   the catalog existed would stop dead. That concern is answered by this change rather than
   surviving it — routing is being replaced anyway — but it has to be struck deliberately, because
   projects rely on it now.

## The two paths, one action each

**I assigned it to myself, and chose an agent** — `assignee === owner` and `assignedBy === owner`.
The worker takes it and starts. No prompt, no menubar. One action. Without an agent it is simply a
task I am doing by hand, and no machine looks at it.

**Somebody else assigned it to me** — a request appears in the menubar app. It shows the task and
the agent that was chosen, expanded into its steps and gates. I can approve it as it stands, or
**swap the agent for one of mine** and then approve. One action, on my side instead of theirs.

Nothing is held until approval. The worker does not take the task while a request is outstanding —
it takes it at the moment of approval, and takes *that* task specifically. This needs one API
change: the claim today takes "the first thing that matches" and will need to take a named task.

## Board state is derived, not stored

"Waiting for my approval" is computable: a task assigned to a person who has a live machine on that
project, sitting in a column with the `approved` role, unheld. The board can render *"waiting on
Rafał's Mac"* with no new field and no risk of stored state drifting from reality.

The approval itself is **local** — the worker records what its owner approved in its own state
directory. This follows the rule that already governs the system: the server never says where
anything runs.

## The approval surface

The menubar app gains a list of pending requests: the task, the proposed agent expanded to steps and
gates, an agent picker, Approve and Dismiss.

This requires a socket route that **starts work**. `worker/src/local-server.ts` carries the comment
*"no route starts work"* — a deliberate constraint, written when the app had no decision-making role.
In this model the app **is** the consent surface, so the constraint is lifted on purpose and the
reason recorded next to it.

**The credential invariant is untouched.** The app still holds no Board Planner credential and still
opens no network connection. It talks to the local worker; the worker talks to the server. That
matters because a machine's credential is an instance-admin credential.

## One thing for the user, two processes underneath

The app owns the worker's whole lifecycle — start, stop, restart, update, logs, failures — so a
person never reaches for a terminal. After BP-352 they are already one artifact: the worker ships
inside `Contents/Resources/worker` and the app spawns it.

What remains is the vocabulary. The product says "worker" in places where a person thinks "my
computer":

- the board and project settings should say **"Rafał's Mac"**, not `worker-6a79…`
- one README, one version number, one build command across `worker/` and `menubar/`

The worker keeps running headless without the app, for a server or CI. This is a change in what the
product *says*, not in what it can do.

## What disappears

`claimAssignee` and `claimScope` both go. One switch remains: whether the project uses machines at
all.

**Migration needs care in one place.** A project set to `claimScope: "any"` takes unassigned tasks
today and will stop. That is a behaviour change, not only a schema change, and belongs in release
notes rather than being discovered.

## What this does to BP-345

It disarms it. If the last word on what executes belongs to the machine's owner at approval time,
then somebody else choosing an agent is a **proposal, not an instruction** — and choosing an agent
stops being a security boundary.

But only once this ships. BP-345 goes out with authoring restricted to instance admins; when this
lands, that bar can be deliberately **lowered** rather than raised.

**It has been lowered.** Choosing a task's agent is an ordinary edit again, gated by nothing beyond
the project access the route already requires. Authoring a step block stays instance-admin: a
block's prompt is what the machine executes, and writing one is a different act from choosing among
blocks somebody already approved.

What the claim gives back in exchange is narrower than the "proposal" above. There is no surface for
accepting one, so a proposal is refused rather than queued: the filter requires
`assignee === assignedBy === owner`, and work somebody else put in your hands never runs.

That still leaves choosing an agent able to arm somebody else's machine — the assignee's, who need
not be the chooser. It is tolerable for an agent somebody vetted, and `POST /api/agents` requires
project-admin for a project-scoped one, but authoring a **personal** agent is open to anyone. So a
personal agent additionally requires the actor to be the task's own assignee, judged on the assignee
the update leaves rather than the one it read. Your own composition goes on your own work; a
colleague's task takes only what the project or the instance sanctioned. The remaining residue —
a hand-over does not re-check an agent already on the task — is in the branch's final-round report.

## Risks and open questions

**`Task.assignedBy` is a new field in a hot path.** It has to be written by every writer of
`assignee`: the board, the edit form, MCP, the PM agent, `assignTask`. A missed writer means a task
that silently needs approval when it should not, or the reverse. The alternative — putting even
self-assignment through approval — was rejected because it restores the double work this design
exists to remove.

**Local approval does not survive a worker reinstall.** Move to a new computer and the requests
reappear. Judged correct — a new machine is a new consent — but it is a decision, not an obvious
consequence.

**A machine with no owner.** Workers enrolled before this change have none. They must claim nothing
until the connecting user enrols them again, rather than falling back to the old behaviour; falling
back would leave the old race alive indefinitely. The fleet console's Owner column says so — such a
machine has no binding error, no failed heartbeat and an empty assignment list, which is also what a
healthy idle machine has.

**A task assigned before `assignedBy` existed.** It has no such key, and a missing field never
equals an ObjectId, so the claim refuses it. Decided during implementation: **no backfill.** The
field answers "did this person hand this to themselves", the document does not record it, and the
obvious guess — `assignedBy := assignee` — silently converts work somebody else handed you into work
you handed yourself, which is the exact distinction this design exists to draw. Nothing is lost:
such a task also has to name an agent to be claimable, and the ones that do were routed by the old
project-wide nominee, so they are assigned to that nominee and must be reassigned regardless — which
records an assigner. The agent picker says so on the task rather than leaving it silent.

**One person, several machines.** Two Macs owned by the same person both match `assignee === owner`,
so the race returns within one person's own hardware. Acceptable — both machines are theirs — but
the request should name which machine is asking. Withdrawal needs no coordination: approving on one
machine claims the task, and the other machine's next poll sees it held and drops its own request.
The race is resolved by the same atomic claim that resolves it today.

## Shape of the work

Two pieces, in this order, because the second is only worth doing once the first has settled what a
machine is:

1. **Ownership, routing and consent** — `Worker.owner`, `Task.assignedBy`, the claim keyed on the
   owner, claim-by-named-task, the pending-request route on the socket, and the approval UI. This is
   the change; everything above describes it.
2. **One thing for the user** — lifecycle fully owned by the app, and the vocabulary swept so the
   product says "Rafał's Mac" wherever a person means their computer. Smaller, and safe to land
   separately.

## Out of scope

- Rewriting the worker in Swift to make it literally one process. That ends headless operation on
  Linux and CI, and is a project of its own.
- Choosing a specific machine per task. Under this design routing follows the assignee, and picking
  between one person's own machines is the narrow remaining case above.
- Standing per-person trust ("always accept Krzysiek's tasks"). Deliberately omitted: the consent is
  blind to what that person composes later, and a personal agent can be rewritten by its author
  after being pinned.
