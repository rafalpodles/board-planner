import { describe, it, expect, afterEach, vi } from "vitest";
import { githubApiBase, githubWebBase } from "./github-host";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("githubApiBase", () => {
  it("is api.github.com when nothing is configured", () => {
    vi.stubEnv("GITHUB_API_BASE_URL", "");
    expect(githubApiBase()).toBe("https://api.github.com");
  });

  it("is whatever the operator configured", () => {
    vi.stubEnv("GITHUB_API_BASE_URL", "https://ghe.corp.example/api/v3");
    expect(githubApiBase()).toBe("https://ghe.corp.example/api/v3");
  });
});

describe("githubWebBase", () => {
  it("is github.com when nothing is configured", () => {
    vi.stubEnv("GITHUB_API_BASE_URL", "");
    expect(githubWebBase()).toBe("https://github.com");
  });

  // The one shape where the API host is not the web host: the API is a subdomain of the site
  it("drops the api subdomain that github.com answers on", () => {
    expect(githubWebBase("https://api.github.com")).toBe("https://github.com");
  });

  // Enterprise Cloud with data residency, where the same subdomain rule applies under a tenant
  it("drops it for the tenant form too", () => {
    expect(githubWebBase("https://api.acme.ghe.com")).toBe("https://acme.ghe.com");
  });

  // Enterprise Server: the API is a path on the site, so the origin is already the web address
  it("is the origin of an Enterprise Server base, path and all discarded", () => {
    expect(githubWebBase("https://ghe.corp.example/api/v3")).toBe("https://ghe.corp.example");
  });

  it("keeps a port, which is how the end-to-end stub is reached", () => {
    expect(githubWebBase("http://127.0.0.1:30061")).toBe("http://127.0.0.1:30061");
  });

  // Read on the render path of every project page: a typo must not throw there
  it("falls back to github.com for a value that is not a url", () => {
    expect(githubWebBase("ghe.corp.example")).toBe("https://github.com");
  });
});
