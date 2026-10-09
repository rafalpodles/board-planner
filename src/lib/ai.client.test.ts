import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => [] as Record<string, unknown>[]);
const create = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  },
}));

const { generateTask, openrouterModel } = await import("./ai");

const CONTEXT = { name: "Board", description: "", choiceFields: [] };

beforeEach(() => {
  constructed.length = 0;
  create.mockReset();
  create.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ title: "T", description: "d", category: "bug", acceptanceCriteria: "" }) } }],
  });
  delete process.env.OPENROUTER_BASE_URL;
});

// BP-652. AI Assist runs on OpenRouter, through OpenAI's SDK, which would otherwise read the operator's
// OpenAI organisation and project (and base URL) from the environment
describe("the client generateTask makes", () => {
  it("talks to OpenRouter with the key it is given, and inherits no OpenAI organisation or project", async () => {
    await generateTask("a task", CONTEXT, "m", "sk-given");

    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({
      apiKey: "sk-given",
      baseURL: "https://openrouter.ai/api/v1",
      organization: null,
      project: null,
    });
  });

  it("names itself to OpenRouter the way the PM agent does", async () => {
    await generateTask("a task", CONTEXT, "m", "sk-given");

    expect(constructed[0]).toMatchObject({
      defaultHeaders: { "HTTP-Referer": expect.stringMatching(/^https?:\/\//), "X-Title": expect.stringContaining("AI Assist") },
    });
  });

  it("goes where OPENROUTER_BASE_URL says, as the PM agent does", async () => {
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/v1";

    await generateTask("a task", CONTEXT, "m", "sk-given");

    expect(constructed[0]).toMatchObject({ baseURL: "http://127.0.0.1:9/v1" });
  });

  it("asks for the model by its OpenRouter name", async () => {
    await generateTask("a task", CONTEXT, "gpt-4o-mini", "sk-given");

    expect(create.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o-mini", response_format: { type: "json_object" } });
  });
});

describe("the model name AI Assist sends", () => {
  it("prefixes the bare OpenAI name the setting has always held", () => {
    expect(openrouterModel("gpt-4o-mini")).toBe("openai/gpt-4o-mini");
  });

  it("leaves a name that already says whose it is", () => {
    expect(openrouterModel("anthropic/claude-haiku")).toBe("anthropic/claude-haiku");
  });
});

// BP-679: a generation that was answered and then judged unusable was still billed
describe("the usage generateTask reports", () => {
  it("says what the provider reported, and says it even when the answer is empty and the generation fails", async () => {
    const usage = { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 };
    const onUsage = vi.fn();
    create.mockResolvedValue({ choices: [{ message: { content: "" } }], usage });

    await expect(generateTask("a task", CONTEXT, "m", "sk-given", onUsage)).rejects.toThrow("Empty response from AI");

    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 900, completionTokens: 100, totalTokens: 1000 }));
  });
});
