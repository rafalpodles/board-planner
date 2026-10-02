import { describe, it, expect, afterEach } from "vitest";
import { configuredProviders, providerById, publicProviders } from "./providers";

const KEYS = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_LABEL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

describe("which identity providers are configured", () => {
  it("is none until the operator sets one", () => {
    expect(configuredProviders()).toEqual([]);
  });

  it("needs the issuer, the client id and the secret together", () => {
    process.env.OIDC_ISSUER = "https://id.example.com";
    process.env.OIDC_CLIENT_ID = "planner";

    expect(configuredProviders()).toEqual([]);
  });

  it("names a generic issuer after OIDC_LABEL, or a default", () => {
    Object.assign(process.env, { OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "planner", OIDC_CLIENT_SECRET: "s" });
    expect(publicProviders()).toEqual([{ id: "oidc", label: "Single sign-on" }]);

    process.env.OIDC_LABEL = "Acme login";
    expect(publicProviders()).toEqual([{ id: "oidc", label: "Acme login" }]);
  });

  it("offers Google at Google's own issuer", () => {
    Object.assign(process.env, { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs" });

    expect(providerById("google")).toMatchObject({ issuer: "https://accounts.google.com", label: "Google" });
  });

  it("never tells a page the secret", () => {
    Object.assign(process.env, { OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "planner", OIDC_CLIENT_SECRET: "s3cret" });

    expect(JSON.stringify(publicProviders())).not.toContain("s3cret");
  });
});
