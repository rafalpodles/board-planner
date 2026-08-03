const REDACTED = "[redacted]";

// A credential in a URL's userinfo is not a token shape, it is a position — so it is redacted by
// where it sits, not by what it looks like. gh pr create against a credential-bearing remote puts
// one straight into the PR url, and the host stays visible because that is the diagnostic part.
const URL_USERINFO = /(https?:\/\/)[^\s/@]+@/g;

// Every alternative carries its own minimum length. A bare `sk-` matches `task-service`,
// `risk-based` and `disk-usage`, and dropping the line it sits on would delete the single most
// informative line a gate rejection has — so only the match is replaced.
//
// Deliberately no \b anchor. It would stop `disk-ant-collector-...` being eaten mid-word, but it
// would also stop matching a secret glued straight to preceding word characters — and truncation
// upstream (delivery.ts's outputTail) can create exactly that glue. The sk-ant- lookaheads get both
// properties instead: a real key carries a digit and a capital, kebab-case English does not.
const SECRET = new RegExp(
  [
    "[Bb]earer\\s+[A-Za-z0-9._~+/-]{20,}",
    // This system accepts Basic auth as well as Bearer, and base64 hides every other pattern here
    "[Bb]asic\\s+[A-Za-z0-9+/=]{16,}",
    "github_pat_[A-Za-z0-9_]{50,}",
    // gho_ is what `gh auth login` stores and delivery.ts forwards GH_TOKEN into gh
    "gh[pousr]_[A-Za-z0-9]{36,}",
    "cpw?_[a-fA-F0-9]{32,}",
    "sk-or-v1-[a-fA-F0-9]{32,}",
    "sk-ant-(?=[\\w-]*\\d)(?=[\\w-]*[A-Z])[\\w-]{20,}",
  ].join("|"),
  "g"
);

export function scrub(text: string): string {
  return text.replace(URL_USERINFO, `$1${REDACTED}@`).replace(SECRET, REDACTED);
}
