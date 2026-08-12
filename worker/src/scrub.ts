const REDACTED = "[redacted]";

// A credential in a URL's userinfo is not a token shape, it is a position — so it is redacted by
// where it sits, not by what it looks like. gh pr create against a credential-bearing remote puts
// one straight into the PR url, and the host stays visible because that is the diagnostic part.
// Any scheme, not only http(s): the agent has Read over the disk with HOME set, and
// mongodb://user:pass@host walked past an https?-anchored pattern (BP-306).
// The scheme is length-bounded, not open-ended: `[a-z][a-z0-9+.-]*` restarts at every character
// of a long summary and scans forward before failing, which is quadratic and timed out the
// runaway-summary test at 30k characters.
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@]+@/gi;

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
    // Kept although the app no longer accepts Basic: base64 hides every other pattern here, and
    // older logs and third-party output still carry it
    "[Bb]asic\\s+[A-Za-z0-9+/=]{16,}",
    "github_pat_[A-Za-z0-9_]{50,}",
    // gho_ is what `gh auth login` stores and delivery.ts forwards GH_TOKEN into gh
    "gh[pousr]_[A-Za-z0-9]{36,}",
    // The cookie name and its value, so the header name stays as the diagnostic part. Redacted by
    // position, so a session value that is not a cps_ shape (truncated, legacy) still goes.
    "(?:__Host-)?bp_session=[^;\\s]+",
    // The group is OPTIONAL and keeps its w branch on purpose: making it mandatory, or dropping w,
    // stops scrubbing cp_ (api tokens) and cpw_ (worker credentials). cpe_ is this worker's own
    // enrolment token, which it can read off its own disk and quote into a summary.
    "cp(?:w|s|e|d|at|rt|ac|ct|c)?_[a-fA-F0-9]{32,}",
    "sk-or-v1-[a-fA-F0-9]{32,}",
    "sk-ant-(?=[\\w-]*\\d)(?=[\\w-]*[A-Z])[\\w-]{20,}",
    // What an agent with Read and HOME finds on a developer's disk, rather than what this
    // codebase mints — ~/.aws, ~/.ssh and a GitLab checkout are all in reach (BP-306)
    "AKIA[0-9A-Z]{16}",
    "ASIA[0-9A-Z]{16}",
    "glpat-[A-Za-z0-9_-]{20,}",
  ].join("|"),
  "g"
);

// A private key is a block, not a token: redacting the header alone leaves the body, and the
// body is the secret. Matched non-greedily so two keys in one text do not merge into one match.
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

export function scrub(text: string): string {
  return text
    .replace(PEM_BLOCK, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(SECRET, REDACTED);
}
