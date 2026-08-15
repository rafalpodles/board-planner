import { describe, it, expect } from "vitest";
import { isPrivateAddress, isInternalName, unbracket } from "./private-address";

// The hostnames are what `new URL()` hands back, brackets and all — the old check
// compared against "::1" and so could never fire (BP-303).
function hostOf(url: string): string {
  return new URL(url).hostname;
}

describe("isPrivateAddress — the cases measured in BP-303", () => {
  // Every one of these was allowed through before
  it.each([
    ["https://[::1]:8443/x", "[::1]"],
    ["https://[::ffff:169.254.169.254]/", "[::ffff:a9fe:a9fe]"],
    ["https://127.0.0.2/", "127.0.0.2"],
    ["https://[fd00::1]/", "[fd00::1]"],
    ["https://[fe80::1]/", "[fe80::1]"],
    ["https://100.64.0.1/", "100.64.0.1"],
    ["https://192.0.0.1/", "192.0.0.1"],
  ])("refuses %s", (url, expectedHost) => {
    expect(hostOf(url)).toBe(expectedHost);
    expect(isPrivateAddress(hostOf(url))).toBe(true);
  });

  // Credit where due: these were already handled, and must stay handled
  it.each([
    "https://2130706433/", // decimal 127.0.0.1
    "https://0x7f000001/", // hex
    "https://127.1/", // short form
    "https://0/",
  ])("keeps refusing the normalised IPv4 form %s", (url) => {
    expect(isPrivateAddress(hostOf(url))).toBe(true);
  });

  it.each([
    "https://10.1.2.3/",
    "https://172.16.0.1/",
    "https://172.31.255.254/",
    "https://192.168.1.10/",
    "https://169.254.169.254/",
    "https://198.18.0.1/",
    "https://255.255.255.255/",
    "https://224.0.0.1/",
  ])("refuses %s", (url) => {
    expect(isPrivateAddress(hostOf(url))).toBe(true);
  });

  it.each([
    "https://[64:ff9b::127.0.0.1]/", // NAT64 wrapping loopback
    "https://[2002:7f00:1::]/", // 6to4 wrapping 127.0.0.1
    "https://[::]/",
    "https://[ff02::1]/",
  ])("refuses the IPv6 form %s", (url) => {
    expect(isPrivateAddress(hostOf(url))).toBe(true);
  });

  it.each([
    "https://8.8.8.8/",
    "https://172.32.0.1/", // just outside 172.16/12
    "https://172.15.255.255/",
    "https://99.64.0.1/", // just outside 100.64/10
    "https://[2606:4700::1111]/", // public v6
    "https://[::ffff:8.8.8.8]/", // mapped, but public
  ])("allows the public address %s", (url) => {
    expect(isPrivateAddress(hostOf(url))).toBe(false);
  });

  // A name is not an address: answering "public" here is what makes the DNS step
  // load-bearing rather than optional
  it("does not claim a hostname is public or private", () => {
    expect(isPrivateAddress("localtest.me")).toBe(false);
    expect(isPrivateAddress("example.com")).toBe(false);
  });
});

describe("isInternalName", () => {
  it.each(["localhost", "db.internal", "printer.local", "metadata.google.internal"])(
    "refuses %s without waiting for DNS",
    (host) => {
      expect(isInternalName(host)).toBe(true);
    }
  );

  it("leaves ordinary names to DNS", () => {
    expect(isInternalName("localtest.me")).toBe(false);
    expect(isInternalName("hooks.slack.com")).toBe(false);
  });
});

describe("unbracket", () => {
  it("strips the brackets WHATWG URL keeps on IPv6 hosts", () => {
    expect(unbracket("[::1]")).toBe("::1");
    expect(unbracket("127.0.0.1")).toBe("127.0.0.1");
  });
});

// The table the BP-317 audit measured against the shipped module. Every row here was *allowed*
// before the fix, so this is the regression rather than a restatement of the rule.
describe("the forms the first table missed", () => {
  it.each([
    ["::127.0.0.1", "IPv4-compatible, deprecated but still routed to loopback by some stacks"],
    ["::7f00:1", "the same address as WHATWG URL normalises it"],
    ["fec0::1", "site-local"],
    ["64:ff9b:1::7f00:1", "NAT64 local-use prefix"],
    ["2001:db8::1", "documentation"],
    ["2001::1", "Teredo, which tunnels to an arbitrary IPv4"],
    ["100::1", "discard-only"],
    ["192.0.2.5", "TEST-NET-1"],
    ["198.51.100.4", "TEST-NET-2"],
    ["203.0.113.9", "TEST-NET-3"],
    ["192.88.99.1", "6to4 relay anycast, deprecated"],
  ])("refuses %s — %s", (host) => {
    expect(isPrivateAddress(host)).toBe(true);
  });

  // The whole ::/96 range goes, not only the embedded-private part: RFC 4291 deprecated the form,
  // so a public-looking address inside it is not a destination anybody legitimately configures
  it("refuses an IPv4-compatible address even when the embedded v4 is public", () => {
    expect(isPrivateAddress("::93.184.216.34")).toBe(true);
  });

  // Without this the additions above could be a blanket "refuse IPv6" and every test would pass
  it.each([
    "2606:4700:4700::1111",
    "2a00:1450:4001:80f::200e",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2002:5db8:d822::1",
  ])("still allows the public address %s", (host) => {
    expect(isPrivateAddress(host)).toBe(false);
  });
});
