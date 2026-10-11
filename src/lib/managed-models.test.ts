import { describe, expect, it } from "vitest";
import { isManagedModel, MANAGED_MODEL_PROVIDERS, openrouterModel, unmanagedModelError, type ManagedProvider } from "./managed-models";
import { platformProviderPreferences } from "./pm/openrouter";

// BP-1024: the providers are one list. What runs on the platform's key, how a request is pinned and what a refusal offers all read it
describe("the list of allowed providers", () => {
  it("is all it takes to allow another: the check, the routing and the refusal follow it", () => {
    const list = MANAGED_MODEL_PROVIDERS as ManagedProvider[];
    expect(isManagedModel("cohere/command-r")).toBe(false);

    list.push({ id: "cohere", label: "Cohere", servedBy: ["cohere"], description: "Cohere's own models (cohere/…)" });
    try {
      expect(isManagedModel("cohere/command-r")).toBe(true);
      expect(isManagedModel("cohere/command-r:online")).toBe(false);
      expect(platformProviderPreferences("cohere/command-r")).toEqual({ data_collection: "deny", only: ["cohere"] });
      expect(unmanagedModelError("x/y")).toContain("(mistralai/…), Cohere's own models (cohere/…), or add");
    } finally {
      list.pop();
    }
    expect(isManagedModel("cohere/command-r")).toBe(false);
  });

  // BP-1026: what the DPA's Annex 3 and the sub-processor page name; a provider is added here only after they do
  it("holds the providers the DPA's sub-processor list names, each pinned to its own OpenRouter slug, and nobody else", () => {
    expect(MANAGED_MODEL_PROVIDERS.map((p) => [p.id, p.servedBy])).toEqual([
      ["openai", ["openai"]],
      ["anthropic", ["anthropic"]],
      ["google", ["google-vertex"]],
      ["mistralai", ["mistral"]],
    ]);
  });

  it.each([
    ["anthropic/claude-haiku-5.5", "anthropic"],
    ["google/gemini-2.5-flash", "google-vertex"],
    ["mistralai/mistral-large", "mistral"],
    ["openai/gpt-6-luna", "openai"],
  ])("runs %s on the platform's key, pinned to %s and to no upstream that may train on it", (model, slug) => {
    expect(isManagedModel(model)).toBe(true);
    expect(platformProviderPreferences(model)).toEqual({ data_collection: "deny", only: [slug] });
  });

  it("leaves out the open-weight models each provider's name is on but which OpenRouter hosts elsewhere", () => {
    for (const model of ["openai/gpt-oss-120b", "google/gemma-3-27b-it"]) {
      expect(isManagedModel(model), model).toBe(false);
      expect(platformProviderPreferences(model)).toEqual({ data_collection: "deny" });
    }
  });

  it("allows no other provider, and no name that only ends or starts like an allowed one", () => {
    for (const model of ["moonshotai/kimi-k2.6", "deepseek/deepseek-v4", "x-anthropic/claude", "anthropic", "google/", "/gemini", "xgoogle/gemini-2.5-pro"]) {
      expect(isManagedModel(model), model).toBe(false);
    }
  });
});

// BP-1001
describe("the models the platform's key runs", () => {
  it("are OpenAI's own models by default, the PM and AI Assist defaults among them, and not gpt-oss, which OpenAI does not serve", () => {
    expect(isManagedModel("openai/gpt-6-luna")).toBe(true);
    expect(isManagedModel(openrouterModel("gpt-4o-mini"))).toBe(true);
    expect(isManagedModel("openai/gpt-4o")).toBe(true);
    expect(isManagedModel("openai/gpt-oss-120b")).toBe(false);
    expect(isManagedModel("moonshotai/kimi-k2.6")).toBe(false);
    expect(isManagedModel("gpt-4o-mini")).toBe(false);
    expect(isManagedModel("xopenai/gpt-4o")).toBe(false);
  });

  it("never include an OpenRouter variant, which can switch on more than a model: :online is a web search by a third party", () => {
    for (const model of ["openai/gpt-4o:online", "openai/gpt-4o-mini:nitro", "openai/gpt-6-luna:free"]) expect(isManagedModel(model), model).toBe(false);
  });

  it("are named in the refusal, with the organisation's own key as the other way", () => {
    expect(unmanagedModelError("openai/gpt-oss-120b")).toBe(
      "The model openai/gpt-oss-120b is not available on Board Planner's AI key. Choose one of: OpenAI's own models (openai/…, not gpt-oss), Anthropic's own models (anthropic/…), Google's models on Vertex AI (google/…, not gemma), Mistral's own models (mistralai/…), or add your organisation's own OpenRouter key in Settings → AI key."
    );
  });
});
