import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookup = vi.fn();

vi.mock("node:dns/promises", () => ({ lookup }));

const { assertPublicDestination, safeFetch, BlockedDestinationError } = await import("./safe-fetch");

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

  it("gives up rather than following redirects forever", async () => {
    fetchMock.mockResolvedValue(redirect("https://elsewhere.example/loop"));

    await expect(safeFetch("https://hooks.slack.com/x")).rejects.toThrow(/redirects/);
  });
});
