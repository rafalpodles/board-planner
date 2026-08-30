import { NextResponse } from "next/server";

/**
 * Route Handlers have no body size limit of their own — `api.bodyParser.sizeLimit` was a Pages
 * Router setting and nothing replaces it — so an unauthenticated handler that opens with
 * `await request.json()` buffers whatever it is sent before a single validation runs.
 *
 * 64 KB against payloads whose largest field is a 200-character hostname. The cap is not tuned to
 * the traffic; it is far enough above every honest body here that reaching it means something
 * other than this app's clients.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * `reason` is for the handful of callers with a person on the other end. This reader knows a body
 * was too big; it does not know the request was somebody dragging a photo onto a task, and
 * "request body must be at most 5308416 bytes" tells them nothing they can act on. A caller that
 * has a better sentence translates; the rest return `response` as it stands.
 */
export type BodyRefusal = { ok: false; reason: "too-large" | "unreadable"; response: NextResponse };

export type JsonBody<T> = { ok: true; value: T } | BodyRefusal;

/**
 * Content-Length is a claim, not a measurement: it is absent on a chunked request and can simply
 * be wrong. It is checked first because when it is honest the refusal costs nothing, and the
 * stream is counted anyway because when it is not, that is the case that matters.
 */
export async function readJsonBody<T = Record<string, unknown>>(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES
): Promise<JsonBody<T>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge(maxBytes);

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, value: {} as T };

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // Releases the connection rather than draining the rest of what was sent, which would be
      // paying for the request this refusal exists to avoid paying for
      await reader.cancel();
      return tooLarge(maxBytes);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    // A body of literal `null` parses to null, and every caller here reaches straight for a field.
    // A null is an object as far as the typeof check goes, so that check alone is not the guard,
    // and `body.name` on it is a TypeError answered as a 500 to an unauthenticated caller. Anything
    // that is not an object becomes an empty one, so the route's own "required" refusal answers.
    const value = typeof parsed === "object" && parsed !== null ? parsed : {};
    return { ok: true, value: value as T };
  } catch {
    return {
      ok: false,
      reason: "unreadable" as const,
      // The wording five other routes already use for this
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }
}

/**
 * The same bound over a form-encoded or multipart body.
 *
 * Content-Length alone is not a cap: it is absent on a chunked request, and a chunked request is
 * exactly how the check is walked past — the same envelope answered 413 with a length and 200
 * without one. So the body is piped through a counter and the parse reads the capped copy: what a
 * caller can make the process allocate is bounded whatever it claims about its own length, or
 * declines to claim.
 */
export async function readFormBody(
  request: Request,
  maxBytes: number
): Promise<JsonBody<FormData>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge(maxBytes);
  if (!request.body) return { ok: true, value: new FormData() };

  let over = false;
  let size = 0;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if ((size += chunk.byteLength) > maxBytes) {
          over = true;
          controller.error(new Error("body over cap"));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );

  try {
    const value = await new Response(counted, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
    return { ok: true, value };
  } catch {
    if (over) return tooLarge(maxBytes);
    return {
      ok: false,
      reason: "unreadable" as const,
      response: NextResponse.json({ error: "request body could not be read" }, { status: 400 }),
    };
  }
}

function tooLarge(maxBytes: number): BodyRefusal {
  return {
    ok: false,
    reason: "too-large",
    response: NextResponse.json(
      { error: `request body must be at most ${maxBytes} bytes` },
      { status: 413 }
    ),
  };
}
