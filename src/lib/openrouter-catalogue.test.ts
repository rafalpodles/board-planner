import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkKey, forgetCatalogue, isListed, listCatalogue } from "./openrouter-catalogue";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  forgetCatalogue();
  process.env.OPENROUTER_BASE_URL = "http://or.test/api/v1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_BASE_URL;
});

// BP-1024
describe("OpenRouter's list of models", () => {
  it("is read without a key, sorted by id, with the id as the name where none is given", async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" }, { id: "anthropic/claude-haiku-5.5" }, { nope: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listCatalogue()).toEqual([
      { id: "anthropic/claude-haiku-5.5", name: "anthropic/claude-haiku-5.5" },
      { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("http://or.test/api/v1/models", expect.not.objectContaining({ headers: expect.anything() }));
  });

  it("is asked once for ten minutes", async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ id: "a/b", name: "B" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await listCatalogue();
    await listCatalogue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an error status", () => json({}, 500)],
    ["a body with no list", () => json({ data: "x" })],
    ["an empty list", () => json({ data: [] })],
  ])("is unknown, not empty, on %s, and is asked again next time", async (_what, answer) => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetchMock);

    expect(await listCatalogue()).toBeNull();
    await listCatalogue();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is unknown when the request fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });

    expect(await listCatalogue()).toBeNull();
  });

  it("lists a model by its id with a variant suffix taken off", () => {
    const catalogue = [{ id: "openai/gpt-4o", name: "GPT-4o" }];

    expect(isListed(catalogue, "openai/gpt-4o")).toBe(true);
    expect(isListed(catalogue, "openai/gpt-4o:online")).toBe(true);
    expect(isListed(catalogue, "openai/gpt-4")).toBe(false);
  });
});

describe("OpenRouter's verdict on a key", () => {
  const answering = (status: number) =>
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init: RequestInit) => json({}, status)));

  it("is valid when it answers, and the key is sent as a bearer token to the key endpoint", async () => {
    answering(200);

    expect(await checkKey("sk-or-v1-abc")).toBe("valid");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://or.test/api/v1/key", expect.objectContaining({ headers: { Authorization: "Bearer sk-or-v1-abc" } }));
  });

  it.each([401, 403])("is rejected on a %s", async (status) => {
    answering(status);

    expect(await checkKey("sk-or-v1-abc")).toBe("rejected");
  });

  it.each([429, 500, 503])("is unknown on a %s: an outage or a limit is no verdict", async (status) => {
    answering(status);

    expect(await checkKey("sk-or-v1-abc")).toBe("unknown");
  });

  it("is unknown when the request fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });

    expect(await checkKey("sk-or-v1-abc")).toBe("unknown");
  });
});
