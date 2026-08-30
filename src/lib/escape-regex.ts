// A leaf module so the browser can escape a project key without pulling in the GitHub API client.
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
