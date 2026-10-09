import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const FILES = ["src", "worker"].flatMap((dir) => {
  try {
    return sources(join(ROOT, dir));
  } catch {
    return [];
  }
});

const whereIs = (pattern: RegExp): string[] =>
  FILES.filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file))
    .sort();

// BP-679: a model call made anywhere else is spend that no limit sees and a key that no plan gated
describe("the gateway is the only door to a model", () => {
  it("names the SDK nowhere but the one module that speaks to the provider for AI Assist", () => {
    expect(whereIs(/from\s+["']openai["']/)).toEqual(["src/lib/ai.ts"]);
  });

  it("calls the provider's completion endpoint from one module", () => {
    expect(whereIs(/chat\/completions/)).toEqual(["src/lib/pm/openrouter.ts"]);
  });

  it("calls that module's chatCompletion from the gateway alone", () => {
    expect(whereIs(/\bchatCompletion\s*\(/)).toEqual(["src/lib/ai-gateway/index.ts", "src/lib/pm/openrouter.ts"]);
  });

  it("makes AI Assist's generation through the gateway, in the one route that makes it", () => {
    expect(whereIs(/\bgenerateTask\s*\(/)).toEqual(["src/app/api/projects/[projectId]/ai/generate-task/route.ts", "src/lib/ai.ts"]);
    expect(readFileSync(join(ROOT, "src/app/api/projects/[projectId]/ai/generate-task/route.ts"), "utf8")).toMatch(/gatewayAssist\(/);
  });

  it("resolves the key a model call is made with in the gateway alone, so no call is made with a key nobody gated", () => {
    expect(whereIs(/\bresolveModelKey\s*\(/)).toEqual(["src/lib/ai-gateway/index.ts", "src/lib/model-keys.ts"]);
  });
});
