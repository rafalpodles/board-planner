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

export type JsonBody<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

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
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) as T };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "request body is not valid JSON" }, { status: 400 }),
    };
  }
}

function tooLarge(maxBytes: number): { ok: false; response: NextResponse } {
  return {
    ok: false,
    response: NextResponse.json(
      { error: `request body must be at most ${maxBytes} bytes` },
      { status: 413 }
    ),
  };
}
