# One notification matrix

Design, 2026-08-19. Tracked as BP-371. Replaces two global booleans with a per-event, per-channel
grid that a project can override.

## The problem

A person gets notified through three channels and can steer exactly one of them, with one switch.

`User.emailNotifications` is a single boolean covering every event in every project.
`User.emailDigest` turns those mails into one roll-up. In-app notifications honour nothing at
all — the bell lights up for everything, always.

The steering that people actually want was built, on the channel nobody turned on.
`project.notificationChannels[]` carries per-project, per-event, on/off — for Slack and Discord.

| Channel | Granularity | Used |
|---|---|---|
| Slack / Discord | per project, per event, on/off | never |
| E-mail | one global boolean | daily |
| In-app | none, always on | daily |

There is a second problem underneath, and it is the one that costs work. The preference is not a
decision anywhere — it is a clause inside the recipient query:

```js
User.find({ _id: { $in: recipientIds }, emailNotifications: true, emailDigest: { $ne: true } })
```

(`src/lib/in-app-notifications.ts:109`). A filter in a query cannot depend on which project the
event came from or which event it was. Nothing per-project is expressible until that clause becomes
a function.

## What this is not

`project.notificationChannels` stays exactly as it is, and keeps its screen.

Those channels are project-owned and have no recipient: `dispatchNotifications` reads the project's
channels and posts, never asking who is watching (`src/lib/notifications.ts:207`). That is a team
broadcast — "a task was created on this board" — and it is a different animal from "you were
mentioned". The two vocabularies differ for that reason:

| Project channels | In-app / e-mail |
|---|---|
| `task_created` | `task_assigned` |
| `status_changed` | `status_changed` |
| `comment_added` | `comment_added` |
| — | `mentioned` |

`task_created` has no addressee. `task_assigned` and `mentioned` mean nothing without one. Folding
both into one screen would let a project admin decide who hears about their own assignment.

Deleting the project channels was considered and rejected: chat integration is table stakes for a
product being sold, and one user not switching it on is not evidence about anyone else.

## The matrix

Four rows, three columns.

|  | in-app | e-mail | Slack/Discord |
|---|---|---|---|
| assigned to you | | | |
| mentioned you | | | |
| status changed | | | |
| new comment | | | |

`task_created` is deliberately absent from the first cut. The four rows above only *filter* a
recipient list the system already computes — watchers and the assignee. `task_created` has no such
list; delivering it would mean computing a new one ("everyone who opted in on this project"). That
is a different mechanism, not another checkbox, and it gets its own task.

## Storage

On the user:

```ts
notifications: {
  defaults: { [event]: { inApp: boolean; email: boolean; chat: boolean } },
  projects: [ { project: ObjectId, matrix: { [event]: { inApp; email; chat } } } ],
  chat:     { kind: "slack" | "discord" | "", webhookUrl: string },
}
```

**The presence of a row in `projects` is the override toggle.** There is no separate boolean, so
there is no way to reach "override on, matrix empty" or its mirror. Switching the override off
deletes the row.

`chat.webhookUrl` is a credential and is encrypted with the same `ENCRYPTION_KEY` the integration
tokens use.

`project.notificationChannels.webhookUrl` is stored in plain text today — the route that saves it
only parses the URL, and `dispatchNotifications` passes it straight to `safeFetch`
(`src/lib/notifications.ts:219`). That leaves two sibling credentials protected differently, which
is worth fixing and is not fixed here: it is its own task, and folding it in would mean touching a
working feature this design promised not to disturb.

## Resolution

```ts
resolveChannels(user, projectId, event) → { inApp: boolean; email: boolean; chat: boolean }
```

The project's row if it has one, otherwise `defaults`. This is the whole architectural change: the
preference leaves the query and becomes a decision, testable on its own and called by all three
dispatch paths rather than restated in each.

### Storage and display are not the same switch

The in-app column controls what the bell **shows**, not whether a row is **stored**, and the
distinction is load-bearing: the digest is assembled from `Notification` documents, not from the
events themselves (`src/lib/digest.ts:66`). If the bell column stopped the write, then in-app off
plus e-mail on plus digest on would deliver nothing at all — a person would get an empty morning
and no way to connect it to a checkbox they cleared days earlier.

So `createNotifications` keeps writing a document for every recipient, and the resolved in-app
value is stored on it as `Notification.inApp` (default `true`). The bell list filters on that
field; it takes everything for the recipient today (`src/app/api/notifications/route.ts:13`). The
digest ignores it and recomputes e-mail eligibility per row through `resolveChannels`, which it can
do because every document carries its project and its type.

The chat column needs two message shapes that do not exist yet. `src/lib/notifications.ts` formats
`task_created`, `status_changed` and `comment_added` for Slack and Discord, because those are the
project channel's events; `task_assigned` and `mentioned` have never been sent to chat and have no
formatter. Both also read differently in a personal channel — "assigned to you", not "assigned in
Board Planner" — so the personal sender gets its own formatters rather than reusing the project
ones.

## Screens

### Settings → Notifications (new)

Joins the **Account** group after Preferences (`src/app/(app)/settings/layout.tsx:19`). In order:
the matrix; the line "applies to every project unless a project overrides it"; the personal chat
connection (Slack or Discord, webhook URL, a test send, enable/disable).

**The Slack/Discord column is disabled until a connection exists.** Otherwise a person can tick
delivery to nowhere, which fails silently — the worst way to fail.

The profile page loses "Receive email notifications": it becomes the e-mail column, and two
controls for one setting is how they drift apart. The digest checkbox moves to this page with its
behaviour untouched, because leaving it alone on Profile would leave it depending on a grid two
pages away.

### Project settings → Notifications (new section)

```ts
{ id: "notifications", label: "Notifications", access: "member" }
```

`member`, not `projectAdmin`. Integrations sits behind `projectAdmin` because a team webhook is the
project's configuration; this section is the opposite, a personal preference, and hiding it from
members would be the same mistake mirrored.

A toggle, "Use my own settings for this project", off by default. Off shows the matrix greyed with
a link to the global one. No connection configuration here.

Switching it on **writes a row copied from the values in force at that moment** — the stored
defaults, or the computed fallback for an account that has never saved. The copy is deliberate: a
project someone has taken the trouble to configure should not shift underneath them the next time
they change a global default.

### Naming

Two things on one settings screen would otherwise both be called Slack:

- the new section: **My notifications** — what this project sends *to you*
- the Integrations block: **Team channels** — what this project sends to a shared channel,
  regardless of who watches what

## API

```
PUT    /api/users/me/notifications              global defaults and the chat connection
PUT    /api/users/me/notifications/[projectId]  the override for one project
DELETE /api/users/me/notifications/[projectId]  drop that override
```

A separate route rather than more fields on `PUT /api/users/me`, because `DELETE` on an override
says what it means while the same thing inside `users/me` would be a magic `null`. The
project-scoped routes go through `withProjectAccess`: overrides cannot be stored for projects the
caller cannot see.

## Migration

No script, and the database is not touched.

An absent `notifications.defaults` is computed on read:

| column | value for an existing account |
|---|---|
| in-app | `true` on every row — today's behaviour, the bell always rings |
| e-mail | `emailNotifications` on every row |
| Slack/Discord | `false` |

Because that is a pure function, existing accounts behave identically until someone saves the
screen, at which point the full object is written. Rolling back means reverting the code; the old
fields are still authoritative and there is nothing to undo.

`emailNotifications` stays in the schema as that fallback, marked in a comment as on its way out.
`emailDigest` is unchanged.

### The digest's recipient query

`digestTick` asks Mongo for `{ emailNotifications: true, emailDigest: true }`
(`src/lib/digest.ts:128`). The replacement condition — "e-mail is on for at least one row" — reads
over an object keyed by event, which MongoDB 4.4 expresses badly.

So the digest selects candidates by `emailDigest: true` and filters them in code through
`resolveChannels`. One source of truth instead of a denormalised boolean that would eventually
disagree with the grid it summarises. The digest runs once a day; the cost is nothing.

A project muted in the e-mail column drops out of the digest as well. Without that, muting would
suppress the mail during the day and deliver it anyway the next morning.

## Testing

- `resolveChannels`: global values, a project override, an account with no `notifications`, a
  project with no row
- a muted project stores its notification with `inApp: false` and the bell list omits it
- a muted e-mail row calls no `sendEmail`
- in-app off with e-mail on still leaves the digest something to list
- a muted project contributes nothing to the digest
- the chat column cannot be ticked with no connection configured
- the project section is visible to an ordinary member, not only to a project admin
