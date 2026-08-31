import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { DEFAULT_PRIORITY, PRIORITIES } from "@/types";
import { createTask, toApiExecution, taskPopulateFields } from "@/lib/task-service";
import { getColumnIds } from "@/lib/columns";
import { Worker } from "@/models/worker";
import { User } from "@/models/user";
import { Project } from "@/models/project";
import { ITaskExecution } from "@/types";


export const GET = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);

  // Build filter
  const filter: Record<string, unknown> = { project: projectId };

  const statusParam = url.searchParams.get("status");
  const category = url.searchParams.get("category");
  // One read, shared by the two project-defined filters below and skipped when neither is asked for
  const board =
    statusParam || category
      ? await Project.findById(projectId, "categories columns").lean()
      : null;

  if (statusParam) {
    // Column ids are project-defined (CP-128), and this filter is comma-separated — so refusing the
    // whole request over one unknown id of several would be harsher than the answer is worth, and a
    // request naming a real column keeps matching nothing for the ids beside it. Refused only when
    // NONE of them exists, which is the shape that cannot mean anything but a typo: both MCP tools
    // described the seeded ids as a closed list, so an agent on a renamed board asked for `todo`,
    // was answered `200 []`, and reported that there was nothing to do (BP-511).
    const statuses = statusParam.split(",").filter(Boolean);
    if (statuses.length > 0) {
      const columnIds = getColumnIds(board);
      if (!statuses.some((id) => columnIds.includes(id))) {
        return NextResponse.json(
          {
            error: `Invalid status "${statusParam.slice(0, 64)}" — project columns: ${columnIds.join(", ")}`,
          },
          { status: 400 }
        );
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
     * `?assignee=rpo` reached Mongoose as a cast crash and answered 500. Every time. The comment on
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
    const user = await User.findOne({ username: assignee.toLowerCase() }, "_id").lean();
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

  const search = url.searchParams.get("search");
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { title: { $regex: escaped, $options: "i" } },
      { description: { $regex: escaped, $options: "i" } },
    ];
  }

  const tasks = await Task.find(filter)
    .sort({ order: 1, createdAt: -1 })
    .populate(taskPopulateFields);

  // The board loads every task, so a raw document here would publish each one's whole execution
  // subdocument — run identity included — to every project member on every page load
  const workerNames = await workerNamesFor(tasks.map((task) => task.execution));
  return NextResponse.json(
    tasks.map((task) => ({
      ...task.toObject(),
      execution: toApiExecution(task.execution, workerNames),
    }))
  );
});


// Only runs still holding a task carry a workerId, so this reads a handful of documents at most —
// and skips the query entirely when nothing is running.
async function workerNamesFor(executions: (ITaskExecution | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(executions.filter((e) => e?.runId && e.workerId).map((e) => e!.workerId))];
  if (ids.length === 0) return new Map();
  const workers = await Worker.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(workers.map((w) => [String(w._id), w.name as string]));
}

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();

  const result = await createTask(projectId, String(user._id), body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.data, { status: 201 });
});
