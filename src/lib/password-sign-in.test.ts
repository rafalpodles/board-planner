import { describe, it, expect, afterEach } from "vitest";
import { assertSignInConfig, passwordSignInEnabled } from "./password-sign-in";

const KEYS = ["PASSWORD_SIGN_IN", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

const withOidc = () =>
  Object.assign(process.env, { OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s" });

describe("PASSWORD_SIGN_IN", () => {
  it.each([[undefined], ["on"], ["ON"], [" on "]])("keeps passwords for %j", (value) => {
    if (value !== undefined) process.env.PASSWORD_SIGN_IN = value;

    expect(passwordSignInEnabled()).toBe(true);
    expect(() => assertSignInConfig()).not.toThrow();
  });

  it("turns them off with a provider to sign in with", () => {
    process.env.PASSWORD_SIGN_IN = "Off";
    withOidc();

    expect(passwordSignInEnabled()).toBe(false);
    expect(() => assertSignInConfig()).not.toThrow();
  });

  // Nobody could sign in to an instance with passwords off and no provider
  it("refuses to start off with no provider configured", () => {
    process.env.PASSWORD_SIGN_IN = "off";

    expect(() => assertSignInConfig()).toThrow(/needs a sign-in provider/);
  });

  it("refuses to start on a value that is neither on nor off", () => {
    process.env.PASSWORD_SIGN_IN = "false";
    withOidc();

    expect(() => assertSignInConfig()).toThrow(/must be "on" or "off"/);
  });
});
