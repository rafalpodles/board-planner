const REDACTED = "[redacted]";

const URL_USERINFO = /([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@]+@/gi;

const SECRET = new RegExp(
  [
    "[Bb]earer\\s+[A-Za-z0-9._~+/-]{20,}",
    "[Bb]asic\\s+[A-Za-z0-9+/=]{16,}",
    "github_pat_[A-Za-z0-9_]{50,}",
    "gh[pousr]_[A-Za-z0-9]{36,}",
    "(?:__Host-)?bp_session=[^;\\s]+",
    "cp(?:w|s|e|d|at|rt|ac|ct|c)?_[a-fA-F0-9]{32,}",
    "sk-or-v1-[a-fA-F0-9]{32,}",
    "sk-ant-(?=[\\w-]*\\d)(?=[\\w-]*[A-Z])[\\w-]{20,}",
    "AKIA[0-9A-Z]{16}",
    "ASIA[0-9A-Z]{16}",
    "glpat-[A-Za-z0-9_-]{20,}",
  ].join("|"),
  "g"
);

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

export function scrub(text: string): string {
  return text
    .replace(PEM_BLOCK, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(SECRET, REDACTED);
}
