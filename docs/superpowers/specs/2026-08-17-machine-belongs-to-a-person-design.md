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

A real `ObjectId` ref to `User`, set at device-enrolment approval from the account that is
connecting. This makes the sentence on the enrolment screen true.

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

## The two paths, one action each

**I assigned it to myself** — `assignee === owner` and `assignedBy === owner`. The worker takes it
and starts. No prompt, no menubar. One action.

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
until an admin or the connecting user adopts them, rather than falling back to the old behaviour;
falling back would leave the old race alive indefinitely.

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
