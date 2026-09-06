import { NextResponse } from "next/server";
import { withProjectAccess } from "@/lib/middleware";
import { interruptTurn } from "@/lib/pm/turn-lock";

export const POST = withProjectAccess(async (_request, { params, user }) => {
  const { projectId } = await params;

  const outcome = interruptTurn(projectId, String(user._id), user.role === "admin");

  if (outcome === "not-running") {
    return NextResponse.json(
      { error: "No PM turn is running for this project" },
      { status: 404 }
    );
  }
  if (outcome === "forbidden") {
    return NextResponse.json(
      { error: "That PM turn belongs to another user" },
      { status: 403 }
    );
  }

  return NextResponse.json({ interrupted: true });
});
