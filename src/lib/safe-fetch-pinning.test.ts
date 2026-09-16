import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Real sockets and the real global fetch: what is under test is which address the connection uses,
// which no stubbed fetch can observe. Only the resolver is scripted.
const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup }));

const { safeFetch, BlockedDestinationError } = await import("./safe-fetch");

let server: Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.end("internal");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  lookup.mockReset();
  hits = 0;
});

// BP-344: the check resolved the name, then fetch resolved it again and connected to that answer
describe("safeFetch connects only to the addresses it vetted", () => {
  it("refuses a name that answers public for the check and private for the connection", async () => {
    lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const attempt = safeFetch(`http://rebind.example:${port}/`, {
      signal: AbortSignal.timeout(5_000),
    });

    await expect(attempt).rejects.toBeInstanceOf(BlockedDestinationError);
    expect(hits).toBe(0);
  });

  // The control. A .localhost name skips the early assertion's lookup entirely, so any call the
  // resolver sees came from the connection itself
  it("connects through its own lookup when the answer is allowed", async () => {
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const response = await safeFetch(
      `http://rebind.localhost:${port}/`,
      { signal: AbortSignal.timeout(5_000) },
      { allowLoopback: true }
    );

    expect(await response.text()).toBe("internal");
    expect(hits).toBe(1);
    expect(lookup).toHaveBeenCalledWith("rebind.localhost", expect.objectContaining({ all: true }));
  });
});
