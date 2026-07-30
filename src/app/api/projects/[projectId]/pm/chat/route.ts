import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getAuthUser, RateLimitError } from "@/lib/auth";
import { Project } from "@/models/project";
import { runPmTurn } from "@/lib/pm/agent";
import { isPmAvailable } from "@/lib/pm/config";
import { acquireTurnLock, releaseTurnLock } from "@/lib/pm/turn-lock";
import { isOverDailyTurnCap } from "@/lib/pm/turn-cap";
import { isPmRunnable, pmDisabledReason } from "@/lib/pm/availability";
import { resolveProjectId } from "@/lib/middleware";

export const maxDuration = 300;

const HEARTBEAT_MS = 15_000;

export async function POST(
  request: Request,
  { params }: { params: Promise<Record<string, string>> }
) {
  let user;
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

  // This route authenticates by hand (it streams SSE) and so never passes through
  // withProjectAccess, which is where key -> id resolution normally happens
  const { projectId: projectRef } = await params;
  const projectId = projectRef ? await resolveProjectId(projectRef) : null;
  if (!projectId) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }
  if (
    user.role !== "admin" &&
    !(user.allowedProjects || []).some((p) => p.toString() === projectId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isPmAvailable()) {
    return NextResponse.json(
      { error: "PM agent is not configured (OPENROUTER_API_KEY missing)" },
      { status: 503 }
    );
  }

  await connectDB();

  const project = await Project.findById(projectId, "pm").lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (!isPmRunnable(project.pm)) {
    return NextResponse.json({ error: pmDisabledReason(project.pm) }, { status: 400 });
  }

  let message: unknown;
  try {
    ({ message } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof message !== "string" || !message.trim() || message.length > 10_000) {
    return NextResponse.json(
      { error: "message must be a non-empty string up to 10000 chars" },
      { status: 400 }
    );
  }

  const { over, cap } = await isOverDailyTurnCap(projectId, project.pm);
  if (over) {
    return NextResponse.json(
      { error: `Daily PM turn cap (${cap}) reached for this project` },
      { status: 429 }
    );
  }

  const abort = acquireTurnLock(projectId);
  if (!abort) {
    return NextResponse.json(
      { error: "A PM turn is already in progress for this project" },
      { status: 409 }
    );
  }

  const encoder = new TextEncoder();
  const userMessage = message.trim();
  const triggeredByUserId = String(user._id);

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Client disconnected — keep the turn running; results land in pmmessages
          closed = true;
        }
      };
      const sendEvent = (event: string, data: unknown) =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      (async () => {
        try {
          const result = await runPmTurn({
            projectId,
            userMessage,
            triggeredByUserId,
            onEvent: (event) => sendEvent("action", event),
            signal: abort.signal,
          });
          if (result.ok) {
            sendEvent("done", { message: result.message, interrupted: result.interrupted });
          } else {
            sendEvent("error", { error: result.error, message: result.message });
          }
        } catch (err) {
          sendEvent("error", {
            error: err instanceof Error ? err.message : "PM turn failed",
          });
          console.error("PM turn crashed:", err);
        } finally {
          clearInterval(heartbeat);
          releaseTurnLock(projectId);
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
