// Where to send someone after they sign in. This value rides in the URL, so it is attacker-reachable
// and is validated as a same-origin *path* — never used as a URL. Getting it wrong is an open
// redirect: a link to our own login that lands the user somewhere else entirely, with our domain in
// the part they read before clicking.
const DEFAULT_DESTINATION = "/projects";

export function safeNextPath(raw: unknown, fallback = DEFAULT_DESTINATION): string {
  if (typeof raw !== "string" || !raw) return fallback;

  // Backslashes are folded into slashes by some parsers and not others, which is exactly the gap a
  // bypass lives in. Refuse rather than normalise.
  if (raw.includes("\\")) return fallback;

  // A path on this origin: one leading slash, and not two — "//evil.example.com" is a
  // protocol-relative URL, which browsers follow off-site quite happily.
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;

  // Control characters and whitespace truncate or split the value in whatever reads it next
  if (/[\u0000-\u0020\u007f]/.test(raw)) return fallback;

  // Bouncing back to the login page is a loop, not a destination
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) return fallback;

  return raw;
}
