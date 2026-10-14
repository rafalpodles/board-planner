import type { ShownActivitySource } from "@/types";

const LABELS: Record<ShownActivitySource, string> = {
  "web-ui": "Web",
  "pm-agent": "PM agent",
  worker: "Worker",
  mcp: "MCP",
  api: "API",
  import: "Import",
  system: "System",
  legacy: "Legacy",
};

const HUMAN: ReadonlySet<ShownActivitySource> = new Set(["web-ui", "legacy"]);

export function sourceOf(source: string | undefined): ShownActivitySource {
  return source && source in LABELS ? (source as ShownActivitySource) : "legacy";
}

export function sourceLabel(source: ShownActivitySource): string {
  return LABELS[source];
}

export function isMachineSource(source: ShownActivitySource): boolean {
  return !HUMAN.has(source);
}

export function sourceTitle(source: ShownActivitySource, detail?: string): string {
  switch (source) {
    case "web-ui":
      return "Through the web app";
    case "pm-agent":
      return detail ? `By the PM agent (${detail})` : "By the PM agent";
    case "worker":
      return detail ? `By the worker ${detail}` : "By a worker";
    case "mcp":
      return detail ? `Through MCP: ${detail}` : "Through MCP";
    case "api":
      return detail ? `Through the API: ${detail}` : "Through the API";
    case "import":
      return "By an import";
    case "system":
      return "By Board Planner itself, with nobody acting";
    case "legacy":
      return "Recorded before Board Planner kept where entries came from";
  }
}
