import { NextResponse } from "next/server";
import { isValidObjectId, Types } from "mongoose";
import { getAuthUser, RateLimitError } from "./auth";
import { connectDB } from "./db";
import { Project } from "@/models/project";
import { IProject, IUser } from "@/types";

type AuthenticatedHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>>; user: IUser }
) => Promise<NextResponse | Response>;

export function withAuth(handler: AuthenticatedHandler) {
  return async (
    request: Request,
    context: { params: Promise<Record<string, string>> }
  ) => {
    let user: IUser | null;
    try {
      user = await getAuthUser(request);
    } catch (e) {
      if (e instanceof RateLimitError) {
        return NextResponse.json({ error: e.message }, { status: 429 });
      }
      throw e;
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return handler(request, { ...context, user });
  };
}

export function withAdmin(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    if (context.user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handler(request, context);
  });
}

function refId(ref: Types.ObjectId | IUser): string {
  const populated = (ref as { _id?: Types.ObjectId })._id;
  return (populated ?? ref).toString();
}

export function canAdminProject(
  user: IUser,
  project: Pick<IProject, "owner" | "admins">
): boolean {
  if (user.role === "admin") return true;
  if (user.tokenScoped) return false;
  const uid = user._id.toString();
  if (project.owner && refId(project.owner) === uid) return true;
  return (project.admins || []).some((a) => refId(a) === uid);
}

export function withProjectAdmin(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId;
    if (!projectId || !isValidObjectId(projectId)) {
      return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
    }

    if (user.role === "admin") {
      return handler(request, context);
    }
    if (user.tokenScoped) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await connectDB();
    const project = await Project.findById(projectId).select("owner admins");
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (!canAdminProject(user, project)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return handler(request, context);
  });
}

export function withProjectAccess(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId;
    if (!projectId || !isValidObjectId(projectId)) {
      return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
    }

    if (user.role === "admin") {
      return handler(request, context);
    }

    const allowedProjects = user.allowedProjects || [];
    const hasAccess = allowedProjects.some(
      (p) => p.toString() === projectId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return handler(request, context);
  });
}
