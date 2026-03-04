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
  duplicateOf: number | null;
  duplicateReason: string;
  suggestedBlockedBy: number[];
  suggestedBlocking: number[];
  dependencyReason: string;
}

export interface ExistingTaskSummary {
  taskNumber: number;
  title: string;
  status: string;
  description: string;
}

interface ProjectContext {
  name: string;
  description: string;
  components: string[];
  readme?: string;
  existingTasks?: ExistingTaskSummary[];
}

export async function generateTask(
  prompt: string,
  context: ProjectContext,
  model: string = "gpt-4o-mini"
): Promise<GeneratedTask> {
  const client = getClient();

  const componentList =
    context.components.length > 0
      ? `Available components: ${context.components.join(", ")}`
      : "No components defined yet.";

  const readmeSection = context.readme
    ? `\n\nProject README (truncated):\n${context.readme}`
    : "";

  const existingTasksSection =
    context.existingTasks && context.existingTasks.length > 0
      ? `\n\nExisting tasks in this project:\n${context.existingTasks
          .map(
            (t) =>
              `- #${t.taskNumber} [${t.status}] ${t.title}${t.description ? `: ${t.description.slice(0, 100)}` : ""}`
          )
          .join("\n")}`
      : "";

  const systemPrompt = `You are a project management assistant. Given a brief task description, generate a well-structured task/user story for a software project.

Project: ${context.name}
${context.description ? `Project description: ${context.description}` : ""}
${componentList}${readmeSection}${existingTasksSection}

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
- duplicateOf: task number (integer) if this task is a duplicate or very similar to an existing task, or null if not a duplicate
- duplicateReason: brief explanation if duplicate detected, or empty string
- suggestedBlockedBy: array of existing task numbers (integers) that should be completed before this new task can start (dependencies). Empty array if none.
- suggestedBlocking: array of existing task numbers (integers) that this new task would block (i.e. those tasks depend on this work). Empty array if none.
- dependencyReason: brief explanation of why these dependencies exist, or empty string if no dependencies

Write clear, actionable descriptions. Focus on the "what" and "why", not the "how" in detail.
When analyzing duplicates and dependencies, consider the semantic meaning, not just keyword matching.`;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.7,
    max_tokens: 1500,
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

  // Coerce acceptanceCriteria array to string (LLM sometimes returns arrays)
  if (Array.isArray(parsed.acceptanceCriteria)) {
    parsed.acceptanceCriteria = (parsed.acceptanceCriteria as unknown as string[]).join("\n");
  }

  // Sanitize new fields
  if (typeof parsed.duplicateOf !== "number") {
    parsed.duplicateOf = null;
  }
  parsed.duplicateReason = parsed.duplicateReason || "";
  parsed.suggestedBlockedBy = Array.isArray(parsed.suggestedBlockedBy)
    ? parsed.suggestedBlockedBy.filter((n) => typeof n === "number")
    : [];
  parsed.suggestedBlocking = Array.isArray(parsed.suggestedBlocking)
    ? parsed.suggestedBlocking.filter((n) => typeof n === "number")
    : [];
  parsed.dependencyReason = parsed.dependencyReason || "";

  return parsed;
}
