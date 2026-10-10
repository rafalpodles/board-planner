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
    expect(whereIs(/from\s+["']openai["']|import\(\s*["']openai["']|require\(\s*["']openai["']/)).toEqual(["src/lib/ai.ts"]);
  });

  it("calls the provider's completion endpoint from one module", () => {
    expect(whereIs(/chat\/completions/)).toEqual(["src/lib/pm/openrouter.ts"]);
  });

  it("calls that module's chatCompletion from the gateway alone", () => {
    expect(whereIs(/\bchatCompletion\b/)).toEqual(["src/lib/ai-gateway/index.ts", "src/lib/pm/openrouter.ts"]);
  });

  it("makes AI Assist's generation through the gateway, in the one route that makes it", () => {
    expect(whereIs(/\bgenerateTask\s*\(/)).toEqual(["src/app/api/projects/[projectId]/ai/generate-task/route.ts", "src/lib/ai.ts"]);
    const route = readFileSync(join(ROOT, "src/app/api/projects/[projectId]/ai/generate-task/route.ts"), "utf8");
    expect(route.match(/\bgenerateTask\s*\(/g)).toHaveLength(1);
    expect(route).toMatch(
      /gatewayAssist\([^]*?\(apiKey, report, onPlatformKey\) =>\s*generateTask\([^]*?\bapiKey\b[^]*?\breport\b[^]*?\bonPlatformKey\b/
    );
  });

  it("resolves the key a model call is made with in the gateway alone, so no call is made with a key nobody gated", () => {
    expect(whereIs(/\bresolveModelKey\b/)).toEqual(["src/lib/ai-gateway/index.ts", "src/lib/model-keys.ts"]);
  });

  // BP-682: AI the operator runs for an organisation is counted; an agent a person runs on their own machine is theirs, and is never swept in
  it("is entered from the PM agent's callers, AI Assist's route, the boot warning and the places that show usage or the operator's lock, and nowhere else", () => {
    const users = whereIs(/@\/lib\/ai-gateway/);

    expect(users).toEqual(
      [
        "src/app/api/platform/organisations/[organisationId]/ai-allowance/route.ts",
        "src/app/api/platform/organisations/[organisationId]/ai/route.ts",
        "src/app/api/platform/organisations/route.ts",
        "src/app/api/projects/[projectId]/ai/generate-task/route.ts",
        "src/app/api/projects/[projectId]/pm/chat/route.ts",
        "src/app/api/projects/[projectId]/pm/review/route.ts",
        "src/app/api/settings/ai-keys/route.ts",
        "src/instrumentation-node.ts",
        "src/lib/pm/agent.ts",
        "src/lib/pm/scheduler.ts",
        "src/lib/pm/triggers.ts",
      ].sort()
    );
  });

  it("writes and reads the usage rows and counters from the gateway and the PM's day alone, so a worker's run cannot land on them by another road", () => {
    expect(whereIs(/\bAiUsage\b|\bAiBudget\b|\brecordUsage\b/)).toEqual([
      "src/lib/ai-gateway/budget.ts",
      "src/lib/ai-gateway/index.ts",
      "src/lib/ai-gateway/summary.ts",
      "src/lib/ai-gateway/usage.ts",
      "src/lib/db-scope.ts",
      "src/lib/pm/day-usage.ts",
      "src/models/aiBudget.ts",
      "src/models/aiUsage.ts",
    ]);
  });

  it("is not imported from the PM loop by any file of the worker's", () => {
    const loop = /lib\/pm\/(agent|scheduler|triggers)\b/;
    expect(whereIs(loop).filter((file) => /worker/i.test(file))).toEqual([]);
  });
});
