import { describe, expect, it } from "vitest";
import { isManagedModel, MANAGED_MODEL_PROVIDERS, openrouterModel, unmanagedModelError, type ManagedProvider } from "./managed-models";
import { platformProviderPreferences } from "./pm/openrouter";

// BP-1024: the providers are one list. What runs on the platform's key, how a request is pinned and what a refusal offers all read it
describe("the list of allowed providers", () => {
  it("is all it takes to allow another: the check, the routing and the refusal follow it", () => {
    const list = MANAGED_MODEL_PROVIDERS as ManagedProvider[];
    expect(isManagedModel("mistralai/mistral-large")).toBe(false);

    list.push({ id: "mistralai", label: "Mistral", servedBy: ["mistral"], description: "Mistral's own models (mistralai/…)" });
    try {
      expect(isManagedModel("mistralai/mistral-large")).toBe(true);
      expect(isManagedModel("mistralai/mistral-large:online")).toBe(false);
      expect(platformProviderPreferences("mistralai/mistral-large")).toEqual({ data_collection: "deny", only: ["mistral"] });
      expect(unmanagedModelError("x/y")).toContain("Choose one of: OpenAI's own models (openai/…, not gpt-oss), Mistral's own models (mistralai/…), or add");
    } finally {
      list.pop();
    }
    expect(isManagedModel("mistralai/mistral-large")).toBe(false);
  });

  it("holds OpenAI alone until the DPA's sub-processor list says more", () => {
    expect(MANAGED_MODEL_PROVIDERS.map((p) => p.id)).toEqual(["openai"]);
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
    expect(isManagedModel("anthropic/claude-haiku")).toBe(false);
    expect(isManagedModel("gpt-4o-mini")).toBe(false);
    expect(isManagedModel("xopenai/gpt-4o")).toBe(false);
  });

  it("never include an OpenRouter variant, which can switch on more than a model: :online is a web search by a third party", () => {
    for (const model of ["openai/gpt-4o:online", "openai/gpt-4o-mini:nitro", "openai/gpt-6-luna:free"]) expect(isManagedModel(model), model).toBe(false);
  });

  it("are named in the refusal, with the organisation's own key as the other way", () => {
    expect(unmanagedModelError("openai/gpt-oss-120b")).toBe(
      "The model openai/gpt-oss-120b is not available on Board Planner's AI key. Choose one of: OpenAI's own models (openai/…, not gpt-oss), or add your organisation's own OpenRouter key in Settings → AI key."
    );
  });
});
