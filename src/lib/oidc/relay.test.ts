import { describe, it, expect, afterEach } from "vitest";
import { relayOrigin } from "./relay";

afterEach(() => {
  delete process.env.OIDC_RELAY_ORIGIN;
});

describe("OIDC_RELAY_ORIGIN", () => {
  it.each([[undefined], [""], ["  "]])("is off for %j", (value) => {
    if (value !== undefined) process.env.OIDC_RELAY_ORIGIN = value;

    expect(relayOrigin()).toBeNull();
  });

  it.each([
    ["https://login.example.com", "https://login.example.com"],
    [" https://Login.Example.com/ ", "https://login.example.com"],
    ["https://login.example.com:8443", "https://login.example.com:8443"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000/", "http://[::1]:3000"],
  ])("takes %j as the origin %j", (value, origin) => {
    process.env.OIDC_RELAY_ORIGIN = value;

    expect(relayOrigin()).toBe(origin);
  });

  it.each([
    ["not a URL", "login.example.com"],
    ["plain http off this machine", "http://login.example.com"],
    ["plain http to a name for this machine", "http://localhost:3000"],
    ["a path", "https://login.example.com/sso"],
    ["a query", "https://login.example.com/?a=1"],
    ["a fragment", "https://login.example.com/#x"],
    ["credentials", "https://user:pass@login.example.com"],
    ["another scheme", "ftp://login.example.com"],
  ])("refuses %s, naming the variable", (_label, value) => {
    process.env.OIDC_RELAY_ORIGIN = value;

    expect(() => relayOrigin()).toThrow(/OIDC_RELAY_ORIGIN/);
  });
});
