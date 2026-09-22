import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getClientIp, trustedProxyHops, isIpAddress } from "./client-ip";

const ORIGINAL = { ...process.env };

function request(headers: Record<string, string> = {}) {
  return new Request("https://app.example.com/api/auth/login", { method: "POST", headers });
}

beforeEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

// BP-318: the header was read unconditionally, so on the deployment the README documents — compose
// publishing the port directly — every request named its own throttle bucket and the only
// brute-force control counted to one and reset.
describe("getClientIp with no proxy configured", () => {
  it("ignores the header entirely, however plausible it looks", () => {
    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.9" }))).toBeNull();
  });

  it("gives every forged value the same answer, so they share one bucket", () => {
    const answers = ["203.0.113.1", "203.0.113.2", "203.0.113.3"].map((ip) =>
      getClientIp(request({ "x-forwarded-for": ip }))
    );

    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBeNull();
  });

  it("is null when there is no header at all", () => {
    expect(getClientIp(request())).toBeNull();
  });
});

describe("getClientIp behind the configured number of proxies", () => {
  it("takes the entry the nearest proxy wrote, not the one the caller sent", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";

    const ip = getClientIp(request({ "x-forwarded-for": "10.9.9.9, 203.0.113.9" }));

    expect(ip).toBe("203.0.113.9");
  });

  it("counts hops from the right, so two proxies skip the one the caller can reach", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";

    const ip = getClientIp(
      request({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 172.16.0.1" })
    );

    expect(ip).toBe("203.0.113.9");
  });

  // Fewer entries than configured means the request did not come through those proxies, so nothing
  // in the header is the address the operator promised — taking what is there is trusting the caller
  it("refuses a header with fewer entries than the configured hops", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";

    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.9" }))).toBeNull();
  });

  it("refuses an entry that is not an address", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";

    expect(getClientIp(request({ "x-forwarded-for": "not-an-ip" }))).toBeNull();
    expect(getClientIp(request({ "x-forwarded-for": "a".repeat(4000) }))).toBeNull();
  });

  it("accepts IPv6, which a proxy on a v6 network writes", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";

    expect(getClientIp(request({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("tolerates the spacing and empty entries a chain of proxies produces", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";

    expect(getClientIp(request({ "x-forwarded-for": " 10.0.0.1 ,  203.0.113.9 , " }))).toBe(
      "203.0.113.9"
    );
  });
});

describe("trustedProxyHops", () => {
  it("is 0 when unset — the header is not read at all", () => {
    expect(trustedProxyHops()).toBe(0);
  });

  // Silently reading it as 0 would leave an operator who meant to be behind a proxy with a throttle
  // keyed on nothing and no sign of it
  it.each(["one", "-1", "1.5", "true", "0x1", "1e2", "٣"])("refuses to start on %o", (value) => {
    process.env.TRUSTED_PROXY_HOPS = value;

    expect(() => trustedProxyHops()).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it("accepts a plain integer", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";

    expect(trustedProxyHops()).toBe(2);
  });
});

describe("isIpAddress", () => {
  it.each(["1.2.3.4", "255.255.255.255", "::1", "2001:db8::1", "::ffff:192.0.2.1", "fe80::1%eth0"])(
    "accepts %o",
    (value) => expect(isIpAddress(value)).toBe(true)
  );

  it.each(["", "256.1.1.1", "1.2.3", "1.2.3.4.5", "example.com", "12345", "1.2.3.4 "])(
    "refuses %o",
    (value) => expect(isIpAddress(value)).toBe(false)
  );
});

// BP-774. Production ran behind Railway's proxy with the variable unset, and nothing said so.
describe("a forwarded request with no proxy configured", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function fresh(hops?: string) {
    vi.resetModules();
    delete process.env.TRUSTED_PROXY_HOPS;
    if (hops !== undefined) process.env.TRUSTED_PROXY_HOPS = hops;
    return (await import("./client-ip")).getClientIp;
  }

  const forwarded = (value: string) =>
    new Request("https://app.example.com/api/auth/login", { headers: { "x-forwarded-for": value } });

  const chain = (entries: number) =>
    Array.from({ length: entries }, (_, i) => `203.0.113.${i + 1}`).join(", ");

  it("says once that the header is ignored, and still ignores it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    expect(getIp(forwarded("203.0.113.9"))).toBeNull();
    expect(getIp(forwarded("203.0.113.9"))).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("TRUSTED_PROXY_HOPS=0");
  });

  it("says nothing about a request that carries no such header", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    getIp(new Request("https://app.example.com/api/auth/login"));

    expect(warn).not.toHaveBeenCalled();
  });

  // The count is the number TRUSTED_PROXY_HOPS wants, so an operator reads the value off the log
  // rather than guessing at their chain
  it("names how many entries the header carried", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    getIp(forwarded("203.0.113.9, 172.16.0.1"));

    expect(warn.mock.calls[0][0]).toContain("carrying 2 entries");
  });

  it("says entry, not entries, for a header with one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    getIp(forwarded("203.0.113.9"));

    expect(warn.mock.calls[0][0]).toContain("carrying 1 entry");
  });

  // Blank and padded entries are what a chain of proxies produces; the count has to be the count of
  // addresses, which is the number the operator would set
  it("counts the addresses, not the commas", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    getIp(forwarded(" 203.0.113.9 ,  , 172.16.0.1 , "));

    expect(warn.mock.calls[0][0]).toContain("carrying 2 entries");
  });

  // A health check or an uptime probe reaches the app by a shorter path than a browser does, and
  // whichever arrives first is a sample of one. A second path through the chain is the case the
  // operator needs to see before choosing a number.
  it("reports again when a later request carries a different count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    getIp(forwarded("203.0.113.9"));
    getIp(forwarded("203.0.113.9, 172.16.0.1"));
    getIp(forwarded("198.51.100.4"));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("carrying 1 entry");
    expect(warn.mock.calls[1][0]).toContain("carrying 2 entries");
  });

  it("never repeats a count it has already reported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    for (let i = 0; i < 20; i++) getIp(forwarded("203.0.113.9, 172.16.0.1"));

    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Without a bound, a caller who varies the header's length has a per-request log
  it("holds a fifth count back once four have been reported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    for (let entries = 1; entries <= 9; entries++) getIp(forwarded(chain(entries)));

    expect(warn).toHaveBeenCalledTimes(4);
  });

  // The bound must not let an outsider who burns the four slots with forged lengths suppress the
  // operator's own sign-in: a count still unseen is reported once the quiet period is up
  it("reports a still-unseen count again after the quiet period", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    for (let entries = 1; entries <= 9; entries++) getIp(forwarded(chain(entries)));
    expect(warn).toHaveBeenCalledTimes(4);

    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    getIp(forwarded(chain(7)));

    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls[4][0]).toContain("carrying 7 entries");
  });

  // A count held back is not remembered, or the quiet period would swallow it for good
  it("does not count a held-back request as reported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    for (let entries = 1; entries <= 5; entries++) getIp(forwarded(chain(entries)));
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    getIp(forwarded(chain(5)));

    expect(warn.mock.calls[4][0]).toContain("carrying 5 entries");
  });

  // Nothing to measure, and "set it to 0" is advice to change nothing — so it says nothing and
  // spends none of the four
  it.each(["", " ", " , , "])("says nothing about a header carrying no address (%o)", async (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    expect(getIp(forwarded(value))).toBeNull();
    getIp(forwarded(chain(1)));
    getIp(forwarded(chain(2)));
    getIp(forwarded(chain(3)));
    getIp(forwarded(chain(4)));

    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.every((call) => !String(call[0]).includes("carrying 0"))).toBe(true);
  });

  // The measurement is only the right number if each proxy adds an entry rather than overwriting
  it("tells the operator the count counts only where every proxy appends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    getIp(forwarded(chain(2)));

    expect(warn.mock.calls[0][0]).toContain("appends rather than replaces");
  });

  // getClientIp runs on the login POST, after the body validates — opening the page logs nothing
  it("names the sign-in attempt that produces the count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh();

    getIp(forwarded(chain(2)));

    expect(warn.mock.calls[0][0]).toContain("sign-in you attempted yourself");
  });

  it("stays silent once the hops are set, whatever the header carries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getIp = await fresh("1");

    expect(getIp(forwarded("10.0.0.1, 203.0.113.9"))).toBe("203.0.113.9");
    getIp(forwarded("203.0.113.9"));

    expect(warn).not.toHaveBeenCalled();
  });
});
