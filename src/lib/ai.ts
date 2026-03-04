import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAPI_KEY;

export function isAIEnabled(): boolean {
  return !!apiKey;
}

function getClient(): OpenAI {
  if (!apiKey) {
    throw new Error("OpenAI API key not configured");
  }
  return new OpenAI({ apiKey });
}

export interface GeneratedTask {
  title: string;
  description: string;
  difficulty: "S" | "M" | "L" | "XL";
  category: "bug" | "doc" | "user-story" | "idea";
  acceptanceCriteria: string;
  component: string;
}

interface ProjectContext {
  name: string;
  description: string;
  components: string[];
  readme?: string;
}

export async function generateTask(
  prompt: string,
  context: ProjectContext
): Promise<GeneratedTask> {
  const client = getClient();

  const componentList =
    context.components.length > 0
      ? `Available components: ${context.components.join(", ")}`
      : "No components defined yet.";

  const readmeSection = context.readme
    ? `\n\nProject README (truncated):\n${context.readme}`
    : "";

  const systemPrompt = `You are a project management assistant. Given a brief task description, generate a well-structured task/user story for a software project.

Project: ${context.name}
${context.description ? `Project description: ${context.description}` : ""}
${componentList}${readmeSection}

You must respond with a JSON object with these exact fields:
- title: concise imperative task title (max 80 chars)
- description: detailed description explaining what needs to be done, context, and implementation hints. Use markdown formatting.
- difficulty: one of "S", "M", "L", "XL" based on estimated complexity
  - S = trivial, few lines of code or config change
  - M = moderate, a few files, clear approach
  - L = significant, multiple components, some design decisions
  - XL = major feature, architectural changes, many files
- category: one of "bug", "doc", "user-story", "idea"
- acceptanceCriteria: markdown checklist of acceptance criteria (use "- [ ]" format)
- component: best matching component from the available list, or empty string if none match

Write clear, actionable descriptions. Focus on the "what" and "why", not the "how" in detail.`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.7,
    max_tokens: 1000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from AI");
  }

  const parsed = JSON.parse(content) as GeneratedTask;

  // Validate and sanitize
  const validDifficulties = ["S", "M", "L", "XL"];
  const validCategories = ["bug", "doc", "user-story", "idea"];

  if (!validDifficulties.includes(parsed.difficulty)) {
    parsed.difficulty = "M";
  }
  if (!validCategories.includes(parsed.category)) {
    parsed.category = "user-story";
  }
  if (!context.components.includes(parsed.component)) {
    parsed.component = "";
  }

  return parsed;
}
