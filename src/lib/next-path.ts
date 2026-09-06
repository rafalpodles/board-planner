const DEFAULT_DESTINATION = "/projects";

export function safeNextPath(raw: unknown, fallback = DEFAULT_DESTINATION): string {
  if (typeof raw !== "string" || !raw) return fallback;

  if (raw.includes("\\")) return fallback;

  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;

  if (/[\u0000-\u0020\u007f]/.test(raw)) return fallback;

  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) return fallback;

  return raw;
}
