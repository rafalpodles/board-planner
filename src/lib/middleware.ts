import { NextResponse } from "next/server";
import { getAuthUser } from "./auth";
import { IUser } from "@/types";

type AuthenticatedHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>>; user: IUser }
) => Promise<NextResponse | Response>;

export function withAuth(handler: AuthenticatedHandler) {
  return async (
    request: Request,
    context: { params: Promise<Record<string, string>> }
  ) => {
    const user = await getAuthUser(request);

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

export function withProjectAccess(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;
    if (user.role === "admin") {
      return handler(request, context);
    }

    const params = await context.params;
    const projectId = params.projectId;
    if (!projectId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
