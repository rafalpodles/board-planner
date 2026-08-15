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

  // BP-303: no DNS resolution at all, so localtest.me reached 127.0.0.1 with no redirect
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

  // The carve-out isAllowedMcpServerUrl already makes for local MCP servers
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

  // BP-303: not one caller passed redirect:"manual", so the guard only ever saw the
  // URL as configured while Node followed the 302 to the metadata service
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

  // BP-317: the drop was a denylist of this app's own two headers, so GitLab's PRIVATE-TOKEN — the
  // one caller in the repo that authenticates with anything else — was replayed to the new origin.
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

  // origin carries the scheme, so this is the same host and still a different origin — the
  // credential would otherwise go out in clear text
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

  it("gives up rather than following redirects forever", async () => {
    fetchMock.mockResolvedValue(redirect("https://elsewhere.example/loop"));

    await expect(safeFetch("https://hooks.slack.com/x")).rejects.toThrow(/redirects/);
  });
});

// BP-317: the 500 characters that reach the log were sliced off a string the process had already
// materialised in full, so an integration host answering an error with a huge body could exhaust
// the container while being politely refused.
describe("reading an upstream error body", () => {
  function streamOf(chunks: string[], onCancel?: () => void): Response {
    const encoder = new TextEncoder();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) return controller.close();
        controller.enqueue(encoder.encode(chunks[index++]));
      },
      cancel: onCancel,
    });
    return new Response(body, { status: 500, statusText: "Server Error" });
  }

  it("stops reading once it has its prefix, rather than draining the body", async () => {
    let pulls = 0;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode("x".repeat(1024)));
      },
    });

    const text = await readBoundedText(new Response(body, { status: 500 }), 4096);

    expect(text).toBe("x".repeat(4096));
    // The stream is infinite: without the bound this never returns at all
    expect(pulls).toBeLessThanOrEqual(5);
  });

  it("cancels the rest of the stream so the connection is not left draining", async () => {
    const cancelled = vi.fn();

    await readBoundedText(streamOf(Array.from({ length: 100 }, () => "y".repeat(1024)), cancelled), 2048);

    expect(cancelled).toHaveBeenCalled();
  });

  it("returns a short body whole", async () => {
    expect(await readBoundedText(streamOf(["not found"]), 4096)).toBe("not found");
  });

  it("survives a body that is missing or breaks mid-read", async () => {
    expect(await readBoundedText(new Response(null, { status: 500 }), 4096)).toBe("");

    const broken = new Response(
      new ReadableStream({ pull: (c) => c.error(new Error("upstream went away")) }),
      { status: 500 }
    );
    expect(await readBoundedText(broken, 4096)).toBe("");
  });

  it("logs a bounded prefix and does not put the body in what the caller sees", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await logUpstreamFailure("GitLab", streamOf([`{"secret":"${"z".repeat(100_000)}"}`]));

    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0][0]).length).toBeLessThan(600);
    error.mockRestore();
  });
});
