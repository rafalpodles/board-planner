import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { check } from "@/lib/grants";
import { withProjectAccess } from "@/lib/middleware";
import { escapeRegex } from "@/lib/escape-regex";
import { MAX_SAVED_VIEWS, MAX_SAVED_VIEWS_PER_PERSON } from "@/lib/identifiers";
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

  const project = await db.Project.findById(projectId).select("customFields categories savedViews").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const isAdmin = await check(db, user, String(project._id), "admin");
  if (shared && !isAdmin) return NextResponse.json({ error: SHARING_IS_FOR_OWNERS }, { status: 403 });

  const parsed = parseViewState(input, board(project));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const owner = new Types.ObjectId(String(user._id));
  const sameName = { $regex: `^${escapeRegex(named.name)}$`, $options: "i" };
  const nameTaken = shared
    ? { shared: true, name: sameName }
    : { shared: false, owner, name: sameName };

  // The ceilings and the name go in the write's own filter, not in a count read above it: every
  // racer sees the same pre-write list, so a check up there bounds nothing (BP-719)
  const added = await db.Project.findOneAndUpdate(
    {
      _id: projectId,
      [`savedViews.${MAX_SAVED_VIEWS - 1}`]: { $exists: false },
      $expr: {
        $lt: [
          {
            $size: {
              $filter: {
                input: { $ifNull: ["$savedViews", []] },
                as: "view",
                cond: { $eq: ["$$view.owner", owner] },
              },
            },
          },
          MAX_SAVED_VIEWS_PER_PERSON,
        ],
      },
      savedViews: { $not: { $elemMatch: nameTaken } },
    },
    { $push: { savedViews: { name: named.name, owner, shared, ...parsed.state } } },
    { returnDocument: "after" }
  );

  if (!added) {
    const current = await db.Project.findById(projectId).select("savedViews").lean();
    if (!current) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const views = (current.savedViews ?? []) as unknown as Stored[];
    const wanted = named.name.toLowerCase();
    if (views.some((v) => v.name.toLowerCase() === wanted && (shared ? v.shared : !v.shared && v.owner.toString() === String(user._id)))) {
      return NextResponse.json({ error: "A view with this name already exists" }, { status: 409 });
    }
    if (views.length >= MAX_SAVED_VIEWS) {
      return NextResponse.json({ error: `A project may have at most ${MAX_SAVED_VIEWS} saved views` }, { status: 400 });
    }
    return NextResponse.json(
      { error: `A person may have at most ${MAX_SAVED_VIEWS_PER_PERSON} saved views on a project` },
      { status: 400 }
    );
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
  if (typeof viewId !== "string" || !Types.ObjectId.isValid(viewId)) {
    return NextResponse.json({ error: "viewId is required" }, { status: 400 });
  }

  const project = await db.Project.findById(projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const userId = String(user._id);
  const isAdmin = await check(db, user, String(project._id), "admin");
  const views = project.savedViews as unknown as Stored[];
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
    if (updates.shared !== view.shared && !isAdmin) {
      return NextResponse.json({ error: SHARING_IS_FOR_OWNERS }, { status: 403 });
    }
    shared = updates.shared;
  }

  const wanted = name.toLowerCase();
  const clash = views.some(
    (v) =>
      v._id.toString() !== viewId &&
      v.name.toLowerCase() === wanted &&
      (shared ? v.shared : !v.shared && v.owner.toString() === view.owner.toString())
  );
  if (clash) return NextResponse.json({ error: "A view with this name already exists" }, { status: 409 });

  const replacesState = "filters" in updates;
  const parsed = replacesState ? parseViewState(updates, board(project)) : null;
  if (parsed && "error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const target = view as unknown as Record<string, unknown>;
  target.name = name;
  target.shared = shared;
  if (parsed && "state" in parsed) Object.assign(target, parsed.state);
  await project.save();

  return NextResponse.json(toApiView(view, userId, isAdmin));
});

export const DELETE = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json().catch(() => null);
  const viewId = body && typeof body === "object" ? (body as Record<string, unknown>).viewId : undefined;
  if (typeof viewId !== "string" || !Types.ObjectId.isValid(viewId)) {
    return NextResponse.json({ error: "viewId is required" }, { status: 400 });
  }

  const project = await db.Project.findById(projectId).select("savedViews").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const userId = String(user._id);
  const isAdmin = await check(db, user, String(project._id), "admin");
  const view = ((project.savedViews ?? []) as unknown as Stored[]).find((v) => v._id.toString() === viewId);
  if (!view || !mayReadView(view, userId)) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if (!mayEditView(view, userId, isAdmin)) return NextResponse.json({ error: "You cannot change this view" }, { status: 403 });

  await db.Project.updateOne({ _id: projectId }, { $pull: { savedViews: { _id: new Types.ObjectId(viewId) } } });
  return NextResponse.json({ ok: true });
});
