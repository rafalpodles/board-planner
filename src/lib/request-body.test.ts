import { describe, it, expect } from "vitest";
import { readJsonBody, readFormBody, MAX_JSON_BODY_BYTES } from "./request-body";

/**
 * BP-322. The point of the cap is what does NOT happen: an oversized body must be refused without
 * being buffered or parsed. Asserting the 413 alone would pass against a handler that read all
 * 500 MB first and then complained, so the tests below count what the server actually pulled off
 * the stream.
 */

// A stream that reports how much of it was consumed — the only way to tell a refusal that saved
// the allocation from one that made it and then apologised.
function countingBody(totalBytes: number, chunkBytes = 16 * 1024) {
  const chunk = new Uint8Array(chunkBytes).fill(0x61); // "a"
  let sent = 0;
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      state.pulled += size;
      controller.enqueue(size === chunkBytes ? chunk : chunk.slice(0, size));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function request(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("https://app.example.com/api/anything", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    // Required by undici for a streaming body
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

describe("readJsonBody", () => {
  it("parses an ordinary body — the control", async () => {
    const result = await readJsonBody(request(JSON.stringify({ name: "laptop", host: "x" })));

    expect(result).toEqual({ ok: true, value: { name: "laptop", host: "x" } });
  });

  it("accepts a body just under the cap, so the cap is not refusing honest payloads", async () => {
    const filler = "b".repeat(MAX_JSON_BODY_BYTES - 64);
    const result = await readJsonBody(request(JSON.stringify({ name: filler })));

    expect(result.ok).toBe(true);
  });

  it("refuses on Content-Length without pulling anything itself", async () => {
    const { stream, state } = countingBody(MAX_JSON_BODY_BYTES * 4);
    const result = await readJsonBody(
      request(stream, { "content-length": String(MAX_JSON_BODY_BYTES * 4) })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    // undici pulls one chunk of its own accord shortly after a streaming Request is constructed, so
    // zero is not assertable — but reading the body would take five chunks to reach the cap, so one
    // is still the difference between refusing on the header and refusing on the stream. Written as
    // a ceiling rather than a before/after delta, which needed a sleep and raced the event loop.
    expect(state.pulled).toBeLessThanOrEqual(16 * 1024);
  });

  it("stops mid-stream when Content-Length is absent, which is the case that matters", async () => {
    // A chunked request carries no length, so the header check cannot be the whole control.
    const oversize = MAX_JSON_BODY_BYTES * 8;
    const { stream, state } = countingBody(oversize);
    const result = await readJsonBody(request(stream));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES + 32 * 1024);
    expect(state.pulled).toBeLessThan(oversize);
    expect(state.cancelled).toBe(true);
  });

  it("stops mid-stream when Content-Length lies about being small", async () => {
    const { stream, state } = countingBody(MAX_JSON_BODY_BYTES * 8);
    const result = await readJsonBody(request(stream, { "content-length": "10" }));

    expect(result.ok).toBe(false);
    // Named, because 512 KB of "a" is not valid JSON either: without this the refusal could be the
    // 400 and the test would read the same.
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(state.pulled).toBeLessThan(MAX_JSON_BODY_BYTES * 8);
  });

  it("answers 400 for a body that is not JSON, and does not throw", async () => {
    const result = await readJsonBody(request("{not json"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("turns a body that is not an object into one, so a field read is not a 500", async () => {
    // A null passes the typeof check, so that check on its own does not catch this one.
    for (const scalar of ["null", "5", "true", '"a string"']) {
      const result = await readJsonBody(request(scalar));
      expect(result.ok, scalar).toBe(true);
      if (result.ok) expect(() => (result.value as { name?: string }).name).not.toThrow();
    }
  });

  it("treats a request with no body at all as an empty object", async () => {
    const result = await readJsonBody(
      new Request("https://app.example.com/api/anything", { method: "POST" })
    );

    expect(result).toEqual({ ok: true, value: {} });
  });

  it("honours a caller-supplied cap below the default", async () => {
    const result = await readJsonBody(request(JSON.stringify({ a: "x".repeat(200) })), 64);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });
});

/**
 * A Content-Length check is not a cap on its own: omit the header and it has nothing to read. That
 * is how the upload limit was walked past — the same envelope answered 413 with a length and 200
 * without one, storing the file. So the body is counted through a stream.
 */
describe("readFormBody", () => {
  async function multipart(fields: Record<string, string>) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const encoded = new Response(form);
    return {
      bytes: new Uint8Array(await encoded.arrayBuffer()),
      contentType: encoded.headers.get("content-type") ?? "",
    };
  }

  function streamed(bytes: Uint8Array, contentType: string, declareLength: boolean) {
    const state = { pulled: 0 };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += bytes.byteLength;
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return {
      state,
      request: new Request("https://app.example.com/api/uploads", {
        method: "POST",
        headers: {
          "content-type": contentType,
          ...(declareLength ? { "content-length": String(bytes.byteLength) } : {}),
        },
        body: stream,
        duplex: "half",
      } as RequestInit),
    };
  }

  it("parses an ordinary form — the control", async () => {
    const { bytes, contentType } = await multipart({ projectId: "BP", note: "hello" });
    const result = await readFormBody(streamed(bytes, contentType, true).request, 1024 * 1024);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.get("projectId")).toBe("BP");
  });

  it("refuses a body over the cap that declares its length", async () => {
    const { bytes, contentType } = await multipart({ padding: "p".repeat(200 * 1024) });
    const result = await readFormBody(streamed(bytes, contentType, true).request, 64 * 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("refuses the same body when it declares no length at all", async () => {
    // The bypass: a chunked request carries no Content-Length, so a header check sees nothing to
    // refuse and the parser allocates the whole thing.
    const { bytes, contentType } = await multipart({ padding: "p".repeat(200 * 1024) });
    const result = await readFormBody(streamed(bytes, contentType, false).request, 64 * 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("answers 400 for a body that is not a form", async () => {
    const request = new Request("https://app.example.com/api/uploads", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=nope" },
      body: "not a form at all",
    });

    const result = await readFormBody(request, 64 * 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});
