import { NextResponse } from "next/server";
import { withProjectAccess } from "@/lib/middleware";
import { interruptTurn } from "@/lib/pm/turn-lock";

export const POST = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;

  if (!interruptTurn(projectId)) {
    return NextResponse.json(
      { error: "No PM turn is running for this project" },
      { status: 404 }
    );
  }

  return NextResponse.json({ interrupted: true });
});
