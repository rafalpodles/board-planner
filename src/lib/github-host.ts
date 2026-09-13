/**
 * Where this instance's GitHub is.
 *
 * One variable names the API, and the web UI is not always on the same host: github.com answers
 * its API at `api.github.com`, while an Enterprise Server answers at `/api/v3` of the site itself.
 * So the web address has to be derived rather than assumed, and `https://github.com` written into
 * a link is a claim about somebody else's instance (BP-634).
 */

const DEFAULT_API = "https://api.github.com";
const DEFAULT_WEB = "https://github.com";

export function githubApiBase(raw = process.env.GITHUB_API_BASE_URL): string {
  return raw || DEFAULT_API;
}

/**
 * The origin the pull requests of this instance are read by a person at.
 *
 * Stripping a leading `api.` label covers both hosted shapes — `api.github.com` and the data
 * residency form `api.<tenant>.ghe.com` — and leaves an Enterprise Server base alone, where the
 * API is a path and the origin is already the site. A base that is not a url at all falls back to
 * github.com rather than throwing: it is read on the render path of every project page, and an
 * operator's typo must not take those down.
 */
export function githubWebBase(raw = process.env.GITHUB_API_BASE_URL): string {
  let url: URL;
  try {
    url = new URL(githubApiBase(raw));
  } catch {
    return DEFAULT_WEB;
  }
  url.hostname = url.hostname.replace(/^api\./i, "");
  return url.origin;
}
