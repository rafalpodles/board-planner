import { describe, it, expect, afterEach } from "vitest";
import { configuredProviders, providerById, publicProviders } from "./providers";

const KEYS = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_LABEL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "GITHUB_OAUTH_BASE_URL", "GITHUB_API_BASE_URL"];
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

  describe("GitHub", () => {
    const GITHUB_APP = { GITHUB_OAUTH_CLIENT_ID: "gh", GITHUB_OAUTH_CLIENT_SECRET: "ghs" };

    it("is its own app, not a project's pull-request token", () => {
      expect(providerById("github")).toBeNull();

      Object.assign(process.env, GITHUB_APP);
      expect(providerById("github")).toMatchObject({ kind: "github", label: "GitHub", issuer: "https://github.com", clientId: "gh" });
    });

    it("finds an Enterprise Server where pull-request links do", () => {
      Object.assign(process.env, GITHUB_APP, { GITHUB_API_BASE_URL: "https://ghe.example.com/api/v3" });

      expect(providerById("github")?.issuer).toBe("https://ghe.example.com");
    });

    it("lets GITHUB_OAUTH_BASE_URL name the site when the API sits behind a proxy", () => {
      Object.assign(process.env, GITHUB_APP, {
        GITHUB_API_BASE_URL: "https://gh-proxy.corp",
        GITHUB_OAUTH_BASE_URL: "https://ghe.example.com/",
      });

      expect(providerById("github")?.issuer).toBe("https://ghe.example.com");
    });

    it("ignores a GITHUB_OAUTH_BASE_URL that is not a URL", () => {
      Object.assign(process.env, GITHUB_APP, { GITHUB_OAUTH_BASE_URL: "ghe.example.com" });

      expect(providerById("github")?.issuer).toBe("https://github.com");
    });
  });

  it("never tells a page the secret", () => {
    Object.assign(process.env, { OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "planner", OIDC_CLIENT_SECRET: "s3cret" });

    expect(JSON.stringify(publicProviders())).not.toContain("s3cret");
  });
});
