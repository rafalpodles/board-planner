// Every path a secret is stored at, as an array of steps; "*" walks an array
export const SECRET_PATHS: Record<string, string[][]> = {
  Project: [
    ["githubToken"],
    ["gitlabToken"],
    ["codaToken"],
    ["notificationChannels", "*", "webhookUrl"],
    ["pm", "mcpServers", "*", "authToken"],
    ["pm", "mcpServers", "*", "oauth", "clientSecret"],
    ["pm", "mcpServers", "*", "oauth", "accessToken"],
    ["pm", "mcpServers", "*", "oauth", "refreshToken"],
  ],
  User: [["notifications", "chat", "webhookUrl"]],
};

export function secretsIn(node: unknown, steps: string[], at: string[] = []): { path: string; value: string }[] {
  if (steps.length === 0) return typeof node === "string" ? [{ path: at.join("."), value: node }] : [];
  if (typeof node !== "object" || node === null) return [];
  const [step, ...rest] = steps;
  if (step === "*") {
    return Array.isArray(node) ? node.flatMap((item, index) => secretsIn(item, rest, [...at, String(index)])) : [];
  }
  return secretsIn((node as Record<string, unknown>)[step], rest, [...at, step]);
}

// In place: a lean row is the caller's own, and a copy would lose its ObjectIds and Dates
export function dropSecrets(model: string, document: Record<string, unknown>): Record<string, unknown> {
  for (const steps of SECRET_PATHS[model] ?? []) {
    for (const { path } of secretsIn(document, steps)) {
      const keys = path.split(".");
      const holder = keys.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, document);
      delete holder[keys[keys.length - 1]];
    }
  }
  return document;
}
