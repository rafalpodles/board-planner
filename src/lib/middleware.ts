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
