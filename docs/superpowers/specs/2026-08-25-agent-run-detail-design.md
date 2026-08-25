# A run's detail is read by a person

BP-432. Decision, 2026-08-25.

## The question

`AgentRun.detail` was written by the worker on every exit and rendered nowhere. Two answers were
open: it is meant to be read, in which case it needs a screen; or it is diagnostic residue, in which
case it needs a bound and an expiry.

## The decision: meant to be read

It is the account of **why a run ended the way it did**, and it is the only durable one. Every other
trace of a run is cleared on the way out — `execution.runId`, `phase` and `workerId` live on the task
and every exit unsets them, which is why the fleet page can report a run in flight and nothing at all
a second later.

What the worker actually files there (`worker/src/pipeline.ts`, through `recordFor`):

- the reason a gate gave, when the reason is prose rather than a name;
- the pull request a delivered run opened;
- the sentence the agent gave for handing the task back — "the scope is ambiguous";
- the machine-side fault that ended it — "the base branch could not be established".

That is exactly the thing an operator wants at the moment a run has just failed and they are deciding
whether to run it again. Not residue.

**A refusal is the one exception, and deliberately.** `recordFor` files the refusing block's key in
`refusedBy` and leaves `detail` empty, because "which gate" is what a report groups by. So an empty
detail on a refused run is expected, and a screen has to say so rather than render a blank.

## No TTL, because the bound already exists

`POST /api/projects/[projectId]/runs` truncates to 2000 characters before it stores anything, so the
per-run cost is capped at the sink and cannot grow with a chattier model. What accumulates is runs,
not detail — and a run is the record of work having happened, which is the same reason the activity
log and the audit log are kept. Nothing here needs expiring that those do not.

## What is not stored, and why the screen does not claim it

There is no per-phase log. `detail` is one string, and phases are emitted as telemetry to the
machine's own bus rather than persisted. A run history that promised a phase timeline would be
inventing one, so the surface shows what exists: the end state, the machine, the agent, what it cost,
and the detail.

## Where it is rendered

- `/settings/workers/runs` — every finished run on the instance, newest first, linked from the fleet
  page. Instance admin, in an interactive session, matching `/api/admin/audit`: an unscoped admin API
  token sitting on a worker's disk is readable by the agent running there, and this read spans every
  project.
- A project's own Settings → Workers → Recent runs, for whoever can reach that project. The detail
  was already in that response; only the rendering was missing.
