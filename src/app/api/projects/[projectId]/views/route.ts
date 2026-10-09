import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { check } from "@/lib/grants";
import { withProjectAccess } from "@/lib/middleware";
import { escapeRegex } from "@/lib/escape-regex";
import { isObjectIdSegment } from "@/lib/urls";
import { MAX_SAVED_VIEWS, MAX_SAVED_VIEWS_PER_PERSON, MAX_SHARED_VIEWS } from "@/lib/identifiers";
import {
  mayEditView,
  mayReadView,
  parseViewState,
  toApiView,
  viewNameOrRefusal,
} from "@/lib/saved-views";
import type { ApiCustomField, ApiProjectCategory, ISavedView } from "@/types";

type Stored = ISavedView & { _id: { toString(): string } };

const SHARING_IS_FOR_OWNERS = "Only a project owner shares a view with the project";

function board(project: { customFields?: unknown; categories?: unknown }) {
  return {
    customFields: (project.customFields ?? []) as ApiCustomField[],
    categories: (project.categories ?? []) as ApiProjectCategory[],
  };
}

export const GET = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await db.Project.findById(projectId).select("savedViews").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const userId = String(user._id);
  const isAdmin = await check(db, user, String(project._id), "admin");
  const views = ((project.savedViews ?? []) as unknown as Stored[])
    .filter((view) => mayReadView(view, userId))
    .map((view) => toApiView(view, userId, isAdmin));
  return NextResponse.json(views);
});

const nameMatcher = (name: string) => ({ $regex: `^${escapeRegex(name)}$`, $options: "i" });

/** The names a view of this kind competes with: every shared view, or the same person's personal ones */
const namespaceOf = (shared: boolean, owner: Types.ObjectId) => (shared ? { shared: true } : { shared: false, owner });

const countWhere = (cond: unknown) => ({
  $size: { $filter: { input: { $ifNull: ["$savedViews", []] }, as: "view", cond } },
});

function problemWith(views: Stored[], viewId: string | null, name: string, shared: boolean, owner: string) {
  const wanted = name.toLowerCase();
  const clash = views.some(
    (v) =>
      v._id.toString() !== viewId &&
      v.name.toLowerCase() === wanted &&
      (shared ? v.shared : !v.shared && v.owner.toString() === owner)
  );
  return clash ? "A view with this name already exists" : null;
}

export const POST = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "A JSON object is required" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  const named = viewNameOrRefusal(input.name);
  if ("error" in named) return NextResponse.json({ error: named.error }, { status: 400 });
  if (input.shared !== undefined && typeof input.shared !== "boolean") {
    return NextResponse.json({ error: "shared must be true or false" }, { status: 400 });
  }
  const shared = input.shared === true;

  const project = await db.Project.findById(projectId).select("customFields categories").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const isAdmin = await check(db, user, String(project._id), "admin");
  if (shared && !isAdmin) return NextResponse.json({ error: SHARING_IS_FOR_OWNERS }, { status: 403 });

  const parsed = parseViewState(input, board(project));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const owner = new Types.ObjectId(String(user._id));
  const mine = { $eq: ["$$view.owner", owner] };

  // Every ceiling and the name go in the write's own filter, not in a count read above it: every
  // racer sees the same pre-write list, so a check up there bounds nothing (BP-719). A shared view
  // has a ceiling of its own, so personal views cannot starve the project of them
  const added = await db.Project.findOneAndUpdate(
    {
      _id: projectId,
      ...(shared ? {} : { [`savedViews.${MAX_SAVED_VIEWS - 1}`]: { $exists: false } }),
      $expr: {
        $and: [
          { $lt: [countWhere(mine), MAX_SAVED_VIEWS_PER_PERSON] },
          ...(shared ? [{ $lt: [countWhere({ $eq: ["$$view.shared", true] }), MAX_SHARED_VIEWS] }] : []),
        ],
      },
      savedViews: { $not: { $elemMatch: { ...namespaceOf(shared, owner), name: nameMatcher(named.name) } } },
    },
    { $push: { savedViews: { name: named.name, owner, shared, ...parsed.state } } },
    { returnDocument: "after" }
  );

  if (!added) {
    const current = await db.Project.findById(projectId).select("savedViews").lean();
    if (!current) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const views = (current.savedViews ?? []) as unknown as Stored[];
    const clash = problemWith(views, null, named.name, shared, String(user._id));
    if (clash) return NextResponse.json({ error: clash }, { status: 409 });
    if (shared && views.filter((v) => v.shared).length >= MAX_SHARED_VIEWS) {
      return NextResponse.json({ error: `A project may have at most ${MAX_SHARED_VIEWS} shared views` }, { status: 400 });
    }
    if (views.filter((v) => v.owner.toString() === String(user._id)).length >= MAX_SAVED_VIEWS_PER_PERSON) {
      return NextResponse.json(
        { error: `A person may have at most ${MAX_SAVED_VIEWS_PER_PERSON} saved views on a project` },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: `A project may have at most ${MAX_SAVED_VIEWS} saved views` }, { status: 400 });
  }

  const stored = ((added.savedViews ?? []) as unknown as Stored[]).at(-1)!;
  return NextResponse.json(toApiView(stored, String(user._id), isAdmin), { status: 201 });
});

export const PUT = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "A JSON object is required" }, { status: 400 });
  }
  const { viewId, ...updates } = body as Record<string, unknown>;
  if (typeof viewId !== "string" || !isObjectIdSegment(viewId)) {
    return NextResponse.json({ error: "viewId is required" }, { status: 400 });
  }

  const project = await db.Project.findById(projectId).select("customFields categories savedViews").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const userId = String(user._id);
  const isAdmin = await check(db, user, String(project._id), "admin");
  const views = (project.savedViews ?? []) as unknown as Stored[];
  const view = views.find((v) => v._id.toString() === viewId);
  // A view the reader may not see is the same answer as one that is not there
  if (!view || !mayReadView(view, userId)) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if (!mayEditView(view, userId, isAdmin)) return NextResponse.json({ error: "You cannot change this view" }, { status: 403 });

  let name = view.name;
  if (updates.name !== undefined) {
    const named = viewNameOrRefusal(updates.name);
    if ("error" in named) return NextResponse.json({ error: named.error }, { status: 400 });
    name = named.name;
  }

  let shared = view.shared;
  if (updates.shared !== undefined) {
    if (typeof updates.shared !== "boolean") {
      return NextResponse.json({ error: "shared must be true or false" }, { status: 400 });
    }
    if (updates.shared !== view.shared) {
      // Only its creator moves a view between personal and shared: another owner un-sharing it would
      // hand the creator a personal view past their ceiling, and nobody else could see it again
      if (!isAdmin) return NextResponse.json({ error: SHARING_IS_FOR_OWNERS }, { status: 403 });
      if (view.owner.toString() !== userId) {
        return NextResponse.json({ error: "Only the person who made a view can share or unshare it" }, { status: 403 });
      }
    }
    shared = updates.shared;
  }

  const clash = problemWith(views, viewId, name, shared, view.owner.toString());
  if (clash) return NextResponse.json({ error: clash }, { status: 409 });

  const parsed = "filters" in updates ? parseViewState(updates, board(project)) : null;
  if (parsed && "error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // One write keyed on the view's id, not its position: another request may add or remove views
  // between the read above and this write, and a positional update would then land on a neighbour
  const oid = new Types.ObjectId(viewId);
  const owner = new Types.ObjectId(view.owner.toString());
  const set: Record<string, unknown> = {
    "savedViews.$[view].name": name,
    "savedViews.$[view].shared": shared,
    "savedViews.$[view].updatedAt": new Date(),
  };
  if (parsed && "state" in parsed) {
    for (const [key, value] of Object.entries(parsed.state)) set[`savedViews.$[view].${key}`] = value;
  }
  const updated = await db.Project.findOneAndUpdate(
    {
      _id: projectId,
      $and: [
        { savedViews: { $elemMatch: { _id: oid, owner, shared: view.shared } } },
        { savedViews: { $not: { $elemMatch: { _id: { $ne: oid }, ...namespaceOf(shared, owner), name: nameMatcher(name) } } } },
      ],
    },
    { $set: set },
    { returnDocument: "after", arrayFilters: [{ "view._id": oid }] }
  );

  if (!updated) {
    const current = await db.Project.findById(projectId).select("savedViews").lean();
    const now = ((current?.savedViews ?? []) as unknown as Stored[]).find((v) => v._id.toString() === viewId);
    if (!now || !mayReadView(now, userId)) return NextResponse.json({ error: "View not found" }, { status: 404 });
    const taken = problemWith((current?.savedViews ?? []) as unknown as Stored[], viewId, name, shared, view.owner.toString());
    return NextResponse.json(
      { error: taken ?? "This view was changed at the same time; try again" },
      { status: 409 }
    );
  }

  const stored = ((updated.savedViews ?? []) as unknown as Stored[]).find((v) => v._id.toString() === viewId)!;
  return NextResponse.json(toApiView(stored, userId, isAdmin));
});

export const DELETE = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json().catch(() => null);
  const viewId = body && typeof body === "object" ? (body as Record<string, unknown>).viewId : undefined;
  if (typeof viewId !== "string" || !isObjectIdSegment(viewId)) {
    return NextResponse.json({ error: "viewId is required" }, { status: 400 });
  }

  const project = await db.Project.findById(projectId).select("savedViews").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const userId = String(user._id);
  const isAdmin = await check(db, user, String(project._id), "admin");
  const view = ((project.savedViews ?? []) as unknown as Stored[]).find((v) => v._id.toString() === viewId);
  if (!view || !mayReadView(view, userId)) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if (!mayEditView(view, userId, isAdmin)) return NextResponse.json({ error: "You cannot change this view" }, { status: 403 });

  // The permission is in the pull's own condition, so a view that was un-shared or handed over
  // between the read above and this write is not taken by somebody who may no longer touch it
  const me = new Types.ObjectId(userId);
  await db.Project.updateOne(
    { _id: projectId },
    {
      $pull: {
        savedViews: {
          _id: new Types.ObjectId(viewId),
          ...(isAdmin ? { $or: [{ owner: me }, { shared: true }] } : { owner: me }),
        },
      },
    }
  );
  return NextResponse.json({ ok: true });
});
