const REDACTED = "[redacted]";

// Every pattern carries its own minimum length. A bare `sk-` matches `task-service`, `risk-based`
// and `disk-usage`, and dropping the line it sits on would delete the single most informative line
// a gate rejection has — so only the match is replaced.
const SECRET =
  /Bearer [A-Za-z0-9._~+/-]{20,}|ghp_[A-Za-z0-9]{36}|cpw?_[a-f0-9]{32,}|sk-ant-[\w-]{20,}/g;

export function scrub(text: string): string {
  return text.replace(SECRET, REDACTED);
}
