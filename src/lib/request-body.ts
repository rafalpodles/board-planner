import { NextResponse } from "next/server";

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export type BodyRefusal = { ok: false; reason: "too-large" | "unreadable"; response: NextResponse };

export type JsonBody<T> = { ok: true; value: T } | BodyRefusal;

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
    const value = typeof parsed === "object" && parsed !== null ? parsed : {};
    return { ok: true, value: value as T };
  } catch {
    return {
      ok: false,
      reason: "unreadable" as const,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }
}

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
