import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookup = vi.fn();

vi.mock("node:dns/promises", () => ({ lookup }));

const { assertPublicDestination, safeFetch, BlockedDestinationError, readBoundedText, logUpstreamFailure } =
  await import("./safe-fetch");

const fetchMock = vi.fn();

function redirect(to: string, status = 302) {
  return new Response(null, { status, headers: { location: to } });
}

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
  fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assertPublicDestination", () => {
  it("allows a public host", async () => {
    await expect(assertPublicDestination("https://hooks.slack.com/x")).resolves.toBeInstanceOf(URL);
  });

  it("refuses a public name that resolves inward", async () => {
    lookup.mockResolvedValue([{ address: "127.0.0.1" }]);

    await expect(assertPublicDestination("https://localtest.me/x")).rejects.toThrow(
      BlockedDestinationError
    );
  });

  it("refuses a name whose second address is inward", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "10.0.0.5" }]);

    await expect(assertPublicDestination("https://split.example/x")).rejects.toThrow(/10\.0\.0\.5/);
  });

  it("refuses a literal private address without asking DNS", async () => {
    await expect(assertPublicDestination("https://[::1]:8443/x")).rejects.toThrow(
      BlockedDestinationError
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["localhost", "db.internal", "metadata.google.internal"])(
    "refuses the internal name %s",
    async (host) => {
      await expect(assertPublicDestination(`https://${host}/x`)).rejects.toThrow(
        BlockedDestinationError
      );
    }
  );

  it("refuses a scheme that is not http(s)", async () => {
    await expect(assertPublicDestination("file:///etc/passwd")).rejects.toThrow(
      BlockedDestinationError
    );
  });

  it("refuses a host that does not resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(assertPublicDestination("https://nope.example/x")).rejects.toThrow(/resolve/);
  });

  it("allows loopback only when the caller asks for it", async () => {
    await expect(assertPublicDestination("http://localhost:3001/mcp")).rejects.toThrow(
      BlockedDestinationError
    );
    await expect(
      assertPublicDestination("http://localhost:3001/mcp", { allowLoopback: true })
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetch", () => {
  it("fetches a public destination and returns the response", async () => {
    const res = await safeFetch("https://hooks.slack.com/x", { method: "POST" });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/x",
      expect.objectContaining({ redirect: "manual", method: "POST" })
    );
  });

  it("refuses a redirect that points at a private address", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/"));

    await expect(safeFetch("https://attacker.example/x")).rejects.toThrow(BlockedDestinationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a name that resolves inward", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://localtest.me/x"));
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    lookup.mockResolvedValueOnce([{ address: "127.0.0.1" }]);

    await expect(safeFetch("https://attacker.example/x")).rejects.toThrow(BlockedDestinationError);
  });

  it("follows a redirect that stays public", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://elsewhere.example/y"));

    const res = await safeFetch("https://hooks.slack.com/x");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://elsewhere.example/y", expect.anything());
  });

  it("drops credentials when a redirect crosses origins", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://elsewhere.example/y"));

    await safeFetch("https://hooks.slack.com/x", {
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
    });

    const forwarded = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(forwarded.get("authorization")).toBeNull();
    expect(forwarded.get("content-type")).toBe("application/json");
  });

  it.each([
    ["authorization", "Bearer secret"],
    ["private-token", "glpat-secret"],
    ["cookie", "session=secret"],
    ["x-api-key", "secret"],
    ["proxy-authorization", "Basic secret"],
    ["x-auth-token", "secret"],
  ])("drops %s when a redirect crosses origins", async (name, value) => {
    fetchMock.mockResolvedValueOnce(redirect("https://elsewhere.example/y"));

    await safeFetch("https://hooks.slack.com/x", { headers: { [name]: value } });

    const forwarded = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(forwarded.get(name)).toBeNull();
    expect(JSON.stringify([...forwarded])).not.toContain("secret");
  });

  it("keeps the headers that describe the request rather than the caller", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://elsewhere.example/y"));

    await safeFetch("https://hooks.slack.com/x", {
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "bp" },
    });

    const forwarded = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(forwarded.get("content-type")).toBe("application/json");
    expect(forwarded.get("accept")).toBe("application/json");
    expect(forwarded.get("user-agent")).toBe("bp");
  });

  it("drops credentials on an https to http downgrade to the same host", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://hooks.slack.com/x"));

    await safeFetch("https://hooks.slack.com/x", { headers: { authorization: "Bearer secret" } });

    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("authorization")).toBeNull();
  });

  it("keeps credentials on a same-origin redirect, which is the point of following it", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://hooks.slack.com/y"));

    await safeFetch("https://hooks.slack.com/x", { headers: { authorization: "Bearer secret" } });

    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("authorization")).toBe("Bearer secret");
  });

  it.each([307, 308])("refuses to replay a %i body to another origin", async (status) => {
    fetchMock.mockResolvedValueOnce(redirect("https://collector.example/", status));

    await expect(
      safeFetch("https://mcp.example.com/token", {
        method: "POST",
        body: "grant_type=refresh_token&refresh_token=secret",
      })
    ).rejects.toThrow(/Refusing to replay/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a 307 to the same origin, body and all", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://mcp.example.com/other", 307));

    await safeFetch("https://mcp.example.com/token", { method: "POST", body: "grant_type=x" });

    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    expect(fetchMock.mock.calls[1][1].body).toBe("grant_type=x");
  });

  it("still follows a cross-origin 302 by dropping the method and body", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://elsewhere.example/y", 302));

    await safeFetch("https://hooks.slack.com/x", { method: "POST", body: "payload=1" });

    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
  });

  it("gives up rather than following redirects forever", async () => {
    fetchMock.mockResolvedValue(redirect("https://elsewhere.example/loop"));

    await expect(safeFetch("https://hooks.slack.com/x")).rejects.toThrow(/redirects/);
  });
});

describe("reading an upstream error body", () => {
  function countedStream(chunkCount: number, onCancel?: () => void) {
    const encoder = new TextEncoder();
    const pulled = { count: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled.count >= chunkCount) return controller.close();
        pulled.count += 1;
        controller.enqueue(encoder.encode("x".repeat(1024)));
      },
      cancel: onCancel,
    });
    return { pulled, response: new Response(body, { status: 500, statusText: "Server Error" }) };
  }

  it("reads only as far as its bound, however much the host is willing to send", async () => {
    const { pulled, response } = countedStream(10_000);

    const text = await readBoundedText(response, 4096);

    expect(text).toBe("x".repeat(4096));
    expect(pulled.count).toBeLessThanOrEqual(5);
  });

  it("cancels the rest of the stream so the connection is not left draining", async () => {
    const cancelled = vi.fn();
    const { response } = countedStream(100, cancelled);

    await readBoundedText(response, 2048);

    expect(cancelled).toHaveBeenCalled();
  });

  it("cuts a chunk that is larger than the whole budget", async () => {
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("z".repeat(1_000_000)));
          controller.close();
        },
      }),
      { status: 500 }
    );

    expect((await readBoundedText(oversized, 4096)).length).toBe(4096);
  });

  it("does not leave a replacement character where it stopped", async () => {
    const multibyte = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ą".repeat(100)));
          controller.close();
        },
      }),
      { status: 500 }
    );

    expect(await readBoundedText(multibyte, 5)).toBe("ąą");
  });

  it("does not throw when the body cannot be read at all", async () => {
    const response = new Response("something", { status: 500 });
    response.body!.getReader(); // locks it

    await expect(readBoundedText(response, 4096)).resolves.toBe("");
  });

  it("returns a short body whole", async () => {
    const short = new Response("not found", { status: 500 });

    expect(await readBoundedText(short, 4096)).toBe("not found");
  });

  it("survives a body that is missing or breaks mid-read", async () => {
    expect(await readBoundedText(new Response(null, { status: 500 }), 4096)).toBe("");

    const broken = new Response(
      new ReadableStream({ pull: (c) => c.error(new Error("upstream went away")) }),
      { status: 500 }
    );
    expect(await readBoundedText(broken, 4096)).toBe("");
  });

  it("does not materialise the whole body just to log 500 characters of it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pulled, response } = countedStream(10_000);

    await logUpstreamFailure("GitLab", response);

    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0][0]).length).toBeLessThan(600);
    expect(pulled.count).toBeLessThanOrEqual(5);
    error.mockRestore();
  });
});
