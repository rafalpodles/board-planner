import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { getAuthUser } from "@/lib/auth";
import { ProvenanceError } from "@/lib/session";
import { Project } from "@/models/project";
import { runPmTurn } from "@/lib/pm/agent";
import { isPmAvailable } from "@/lib/pm/config";
import { acquireTurnLock, releaseTurnLock } from "@/lib/pm/turn-lock";
import { dailyPmSpend, isOverDailyTurnCap } from "@/lib/pm/turn-cap";
import { MAX_STEPS } from "@/lib/pm/agent";
import { isPmRunnable, pmDisabledReason, resolvePmModel } from "@/lib/pm/availability";
import { IMAGE_MIME_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, anyAttachmentReadable, modelAcceptsImages } from "@/lib/pm/attachments";
import { databaseUnavailable, resolveProjectId } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { PmAttachment } from "@/types";

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
    if (e instanceof ProvenanceError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (isDatabaseUnreachable(e)) return databaseUnavailable();
    throw e;
  }
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId: projectRef } = await params;
  const projectId = projectRef ? await resolveProjectId(projectRef) : null;
  if (!projectId) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }
  if (!(await check(user, projectId, "access"))) {
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
  let attachments: unknown;
  try {
    ({ message, attachments } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const carriesAttachment = Array.isArray(attachments) && attachments.length > 0;
  if (typeof message !== "string") {
    return NextResponse.json(
      { error: "This request carried no message. Send text, an image, or both." },
      { status: 400 }
    );
  }
  if (message.length > 10_000) {
    return NextResponse.json(
      { error: "That message is too long — 10,000 characters at most." },
      { status: 400 }
    );
  }
  if (!message.trim() && !carriesAttachment) {
    return NextResponse.json(
      { error: "Type something, or attach an image." },
      { status: 400 }
    );
  }

  const parsedAttachments: PmAttachment[] = [];
  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return NextResponse.json(
        { error: `attachments must be an array of at most ${MAX_ATTACHMENTS_PER_MESSAGE} images` },
        { status: 400 }
      );
    }
    for (const a of attachments) {
      if (
        !a ||
        typeof a.fileId !== "string" ||
        typeof a.mimeType !== "string" ||
        !IMAGE_MIME_TYPES.has(a.mimeType)
      ) {
        return NextResponse.json(
          { error: "each attachment needs a fileId and a supported image mimeType" },
          { status: 400 }
        );
      }
      parsedAttachments.push({
        fileId: a.fileId,
        mimeType: a.mimeType,
        width: typeof a.width === "number" ? a.width : undefined,
        height: typeof a.height === "number" ? a.height : undefined,
        bytes: typeof a.bytes === "number" ? a.bytes : undefined,
      });
    }

    const model = await resolvePmModel(project.pm.model);
    if ((await modelAcceptsImages(model)) === false) {
      return NextResponse.json(
        { error: `The configured PM model (${model}) does not accept images. Remove the attachment or switch models in settings.` },
        { status: 400 }
      );
    }
  }

  const { over, cap } = await isOverDailyTurnCap(projectId, project.pm);
  if (over) {
    return NextResponse.json(
      { error: `Daily PM turn cap (${cap}) reached for this project` },
      { status: 429 }
    );
  }

  const spend = await dailyPmSpend(projectId, project.pm);
  if (spend.over) {
    return NextResponse.json(
      {
        error:
          `Daily PM token cap reached for this project: ${spend.tokens.toLocaleString()} of ` +
          `${spend.cap.toLocaleString()} tokens across ${spend.calls} model calls. ` +
          `A turn is up to ${MAX_STEPS} calls, which is why the turn cap alone does not bound this.`,
      },
      { status: 429 }
    );
  }

  const triggeredByUserId = String(user._id);

  if (!message.trim() && !(await anyAttachmentReadable(parsedAttachments, projectId))) {
    return NextResponse.json(
      { error: "That image could not be read. Attach it again, or type a message." },
      { status: 400 }
    );
  }

  const abort = acquireTurnLock(projectId, triggeredByUserId);
  if (!abort) {
    return NextResponse.json(
      { error: "Someone is already talking to the PM agent on this project — try again in a moment" },
      { status: 409 }
    );
  }

  const encoder = new TextEncoder();
  const userMessage = message.trim();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
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
            attachments: parsedAttachments,
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
