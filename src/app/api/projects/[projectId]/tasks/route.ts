import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { DEFAULT_PRIORITY, PRIORITIES } from "@/types";
import { createTask, taskPopulateFields } from "@/lib/task-service";
import { withApiExecutions } from "@/lib/task-execution-view";
import { parentsOf } from "@/lib/task-parents";
import { epicClauses, epicProgressFor } from "@/lib/epics";
import { getColumnIds } from "@/lib/columns";
import { normalizeOptions } from "@/lib/custom-fields";


const MAX_TASK_NUMBERS = 100;
const MAX_FIELD_FILTERS = 10;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day that exists: `Date` takes 2026-02-31 and moves it into March, which would shift a range silently. */
const isCalendarDay = (value: string) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return DAY.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** What a card in a list needs, and what an agent reading a board needs to pick work from it. */
const SUMMARY_FIELDS = "taskNumber title status priority assignee dueDate sprint order updatedAt";

export const GET = withProjectAccess(async (request, { params, db }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);

  // Build filter
  const filter: Record<string, unknown> = { project: projectId };

  const statusParam = url.searchParams.get("status");
  const category = url.searchParams.get("category");
  // One read, shared by the two project-defined filters below and skipped when neither is asked for
  const fieldParams = url.searchParams.getAll("field");
  const board =
    statusParam || category || fieldParams.length
      ? await db.Project.findById(projectId, "categories columns customFields").lean()
      : null;

  if (statusParam) {
    // Column ids are project-defined (CP-128), and this filter is comma-separated — so refusing the
    // whole request over one unknown id of several would be harsher than the answer is worth, and a
    // request naming a real column keeps matching nothing for the ids beside it. Refused only when
    // NONE of them exists, which is the shape that cannot mean anything but a typo: both MCP tools
    // described the seeded ids as a closed list, so an agent on a renamed board asked for `todo`,
    // was answered `200 []`, and reported that there was nothing to do (BP-511).
    const statuses = statusParam.split(",").map((id) => id.trim()).filter(Boolean);
    if (statuses.length > 0) {
      const columnIds = getColumnIds(board);
      // A status no column has is a typo — unless tasks on this board are actually sitting in it,
      // which is what a column deleted out from under them leaves behind. Those tasks are reachable
      // by no screen and by no other query, so refusing the one id that finds them made the state
      // unseeable rather than merely broken (BP-514). The rule BP-311 set is to refuse the act that
      // creates the problem, never the board that already has it.
      if (!statuses.some((id) => columnIds.includes(id))) {
        const orphaned = await db.Task.exists({ project: projectId, status: { $in: statuses } });
        if (!orphaned) {
          return NextResponse.json(
            {
              error: `Invalid status "${statusParam.slice(0, 64)}" — project columns: ${columnIds.join(", ")}`,
            },
            { status: 400 }
          );
        }
      }
      filter.status = { $in: statuses };
    }
  }

  const assignee = url.searchParams.get("assignee");
  if (assignee) {
    /**
     * A **username**, which is what every caller that can reach this filter is told it takes —
     * `list_tasks`'s own parameter description and CLAUDE.md's conventions — and an ObjectId
     * appears in no MCP response, so demanding one makes the filter unreachable from a
     * conversation. It went straight into `filter.assignee`, which is an ObjectId on the model, so
     * `?assignee=owner` reached Mongoose as a cast crash and answered 500. Every time. The comment on
     * the sprint branch below has warned against exactly this since it was written.
     *
     * An id still works, because it always has and this route is public REST — but the **username
     * is tried first**, because `USERNAME_PATTERN` allows 24 hex characters and somebody holding
     * such a name would otherwise be looked up as an id and answered with the silent empty list
     * this whole change exists to remove.
     *
     * Resolved, never access-checked: a task assigned to somebody before they lost access is still
     * a task, and refusing to *look* for it would hide work rather than protect anything. The cost
     * is that this now distinguishes "no such account" from "no tasks" for any authenticated
     * caller — see the ticket raised alongside this change.
     */
    const user = await db.User.findOne({ username: assignee.toLowerCase() }, "_id").lean();
    if (user) {
      filter.assignee = user._id;
    } else if (isValidObjectId(assignee)) {
      filter.assignee = assignee;
    } else {
      // Refused rather than answered with an empty list, so a typo is distinguishable from
      // "nothing is assigned to them" — the two look identical to a reader otherwise.
      // Sliced: this string reaches a model as a tool result, so it is not a place to echo an
      // unbounded parameter back.
      return NextResponse.json(
        { error: `No account named "@${assignee.slice(0, 64)}" — this filter takes a username.` },
        { status: 400 }
      );
    }
  }

  if (category) {
    // Refused, not silently unmatched. A category is project-defined, and both writers refuse an
    // unknown one naming the project's list (`task-service.ts` create and update), so a filter that
    // answered [] would be the one place a typo looked like an empty board.
    const names = (board?.categories || []).map((c: { name: string }) => c.name);
    if (names.length > 0 && !names.includes(category)) {
      return NextResponse.json(
        { error: `Invalid category "${category.slice(0, 64)}" — project categories: ${names.join(", ")}` },
        { status: 400 }
      );
    }
    filter.category = category;
  }

  const priority = url.searchParams.get("priority");
  if (priority) {
    // A closed enum, so an unknown value cannot match anything and returning [] can only ever be a
    // typo answered as a fact
    if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
      return NextResponse.json(
        { error: `Invalid priority "${priority.slice(0, 64)}" — one of: ${PRIORITIES.join(", ")}` },
        { status: 400 }
      );
    }
    // $in with null also matches tasks predating the priority field, which default to medium
    filter.priority =
      priority === DEFAULT_PRIORITY ? { $in: [DEFAULT_PRIORITY, null] } : priority;
  }

  const sprint = url.searchParams.get("sprint");
  if (sprint === "backlog") {
    filter.sprint = null;
  } else if (sprint) {
    // Every caller reaches this filter — REST API, API tokens, MCP — so a malformed
    // value must be refused here rather than reaching Mongoose as a cast crash
    if (!isValidObjectId(sprint)) {
      return NextResponse.json({ error: "Invalid sprint id" }, { status: 400 });
    }
    filter.sprint = sprint;
  }

  // One task, or a few, by the number in their key. How a caller that holds "BP-12" gets the task
  // without downloading the board: every key-addressed MCP tool resolves through this (BP-904).
  const taskNumberParam = url.searchParams.get("taskNumber");
  if (taskNumberParam) {
    const numbers = taskNumberParam.split(",").map((n) => n.trim());
    const valid =
      numbers.length <= MAX_TASK_NUMBERS &&
      numbers.every((n) => /^\d{1,9}$/.test(n) && Number(n) > 0);
    if (!valid) {
      return NextResponse.json(
        {
          error: `Invalid taskNumber "${taskNumberParam.slice(0, 64)}" — positive whole numbers, comma-separated, at most ${MAX_TASK_NUMBERS}`,
        },
        { status: 400 }
      );
    }
    filter.taskNumber = numbers.length === 1 ? Number(numbers[0]) : { $in: numbers.map(Number) };
  }

  const search = url.searchParams.get("search");
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { title: { $regex: escaped, $options: "i" } },
      { description: { $regex: escaped, $options: "i" } },
    ];
  }

  // Every condition below is its own clause, so none can replace the `$or` the text search owns
  const clauses: Record<string, unknown>[] = [];
  const refuse = (error: string) => NextResponse.json({ error }, { status: 400 });

  const dueBefore = url.searchParams.get("dueBefore");
  const dueAfter = url.searchParams.get("dueAfter");
  for (const [name, value, edge] of [
    ["dueBefore", dueBefore, "$lte"],
    ["dueAfter", dueAfter, "$gte"],
  ] as const) {
    if (!value) continue;
    if (!isCalendarDay(value)) {
      return refuse(`Invalid ${name} "${value.slice(0, 64)}" — a day, YYYY-MM-DD`);
    }
    // A due date is a day: "before the 10th" includes the 10th
    clauses.push({
      dueDate: { [edge]: new Date(edge === "$lte" ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`) },
    });
  }

  const updatedSince = url.searchParams.get("updatedSince");
  if (updatedSince) {
    if (!isCalendarDay(updatedSince.slice(0, 10)) || Number.isNaN(Date.parse(updatedSince))) {
      return refuse(`Invalid updatedSince "${updatedSince.slice(0, 64)}" — a day or an ISO timestamp`);
    }
    clauses.push({ updatedAt: { $gte: new Date(updatedSince) } });
  }

  const blocked = url.searchParams.get("blocked");
  if (blocked) {
    if (blocked !== "true" && blocked !== "false") {
      return refuse(`Invalid blocked "${blocked.slice(0, 64)}" — true or false`);
    }
    clauses.push(
      blocked === "true"
        ? { "blockedBy.0": { $exists: true } }
        : { $or: [{ blockedBy: { $exists: false } }, { blockedBy: { $size: 0 } }] }
    );
  }

  // parent_of lives on the parent's document, so both are read from there
  const hasChildren = url.searchParams.get("hasChildren");
  if (hasChildren && hasChildren !== "true" && hasChildren !== "false") {
    return refuse(`Invalid hasChildren "${hasChildren.slice(0, 64)}" — true or false`);
  }
  const epic = await epicClauses(db, projectId, {
    parent: url.searchParams.get("parent") ?? undefined,
    hasChildren: hasChildren ? hasChildren === "true" : undefined,
  });
  if ("error" in epic) return refuse(epic.error);
  clauses.push(...epic.clauses);

  if (fieldParams.length > MAX_FIELD_FILTERS) {
    return refuse(`At most ${MAX_FIELD_FILTERS} field filters`);
  }
  for (const raw of fieldParams) {
    const cut = raw.indexOf(":");
    const fieldId = cut < 0 ? "" : raw.slice(0, cut);
    const value = cut < 0 ? "" : raw.slice(cut + 1);
    const def = (board?.customFields ?? []).find(
      (f: { _id: { toString(): string }; archived?: boolean }) => !f.archived && String(f._id) === fieldId
    );
    if (!def) return refuse(`Invalid field "${raw.slice(0, 64)}" — expected <fieldId>:<value> for one of this board's fields`);

    let wanted: unknown = value;
    if (def.fieldType === "dropdown" || def.fieldType === "multiselect") {
      if (!normalizeOptions(def.options).some((o) => o.id === value)) {
        return refuse(`Invalid option "${value.slice(0, 64)}" for field "${String(def.name).slice(0, 64)}"`);
      }
    } else if (def.fieldType === "number") {
      if (value.trim() === "" || Number.isNaN(Number(value))) {
        return refuse(`Invalid number "${value.slice(0, 64)}" for field "${String(def.name).slice(0, 64)}"`);
      }
      wanted = Number(value);
    } else if (def.fieldType === "checkbox") {
      if (value !== "true" && value !== "false") {
        return refuse(`Invalid value "${value.slice(0, 64)}" for field "${String(def.name).slice(0, 64)}" — true or false`);
      }
      wanted = value === "true";
    } else if (def.fieldType === "text") {
      if (value === "") return refuse(`Empty value for field "${String(def.name).slice(0, 64)}"`);
      // The board's own filter is a case-insensitive "contains", so this answers what the board would
      wanted = { $regex: value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    } else {
      return refuse(`A ${def.fieldType} field cannot be filtered on`);
    }
    const path = `customFieldValues.${fieldId}`;
    // A checkbox nobody touched has no value at all, and the board reads that as "No"
    clauses.push(wanted === false ? { [path]: { $ne: true } } : { [path]: wanted });
  }
  if (clauses.length) filter.$and = clauses;

  const view = url.searchParams.get("view");
  if (view && view !== "summary") return refuse(`Invalid view "${view.slice(0, 64)}" — summary`);

  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const paged = limitParam !== null || offsetParam !== null;
  const limit = limitParam === null ? DEFAULT_PAGE : Number(limitParam);
  const offset = offsetParam === null ? 0 : Number(offsetParam);
  if (paged) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      return refuse(`Invalid limit "${String(limitParam).slice(0, 64)}" — a whole number from 1 to ${MAX_PAGE}`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return refuse(`Invalid offset "${String(offsetParam).slice(0, 64)}" — a whole number, 0 or more`);
    }
  }

  // `_id` last, so a page boundary falls in the same place on every request
  let query = db.Task.find(filter).sort({ order: 1, createdAt: -1, _id: 1 });
  if (view === "summary") query = query.select(SUMMARY_FIELDS);
  if (paged) query = query.skip(offset).limit(limit);
  const tasks = await (view === "summary"
    ? query.populate([
        { path: "assignee", select: "username fullName" },
        { path: "sprint", select: "name" },
      ])
    : query.populate(taskPopulateFields));
  const total = paged ? await db.Task.countDocuments(filter) : undefined;

  // A card shows its parent, and the link lives on the parent's document — so it is resolved from
  // the far end, once for the list. Not part of taskPopulateFields, which can only follow refs a
  // task holds itself, and not left to the browser's own reverse derivation, which only sees the
  // tasks this response carried: under ?sprint= the parent usually is not one of them.
  const taskIds = tasks.map((task) => String(task._id));
  const [parents, progress] = await Promise.all([
    parentsOf(db, projectId, taskIds),
    epicProgressFor(db, projectId, taskIds),
  ]);

  // The board loads every task, so a raw document here would publish each one's whole execution
  // subdocument — run identity included — to every project member on every page load
  const published =
    view === "summary"
      ? tasks.map((task) => (typeof task.toObject === "function" ? task.toObject() : { ...task }))
      : await withApiExecutions(db, tasks);
  const listed = published.map((task) => {
    const counted = progress.get(String(task._id));
    return { ...task, parent: parents.get(String(task._id)) ?? null, ...(counted ? { progress: counted } : {}) };
  });
  return NextResponse.json(paged ? { tasks: listed, total, limit, offset } : listed);
});


export const POST = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();

  const result = await createTask(db, projectId, String(user._id), body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json((await withApiExecutions(db, [result.data]))[0], { status: 201 });
});
