import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
