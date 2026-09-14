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
 * Derived **only** from the two shapes that are GitHub's own API layout, because the variable is
 * documented as accepting a corporate proxy as well (`github.ts`), and a proxy's address is not a
 * repository's. Getting that wrong is not cosmetic: `projectRepositoryUrl` is what a worker is
 * handed as the remote to clone and what `prUrlNamesProjectRepo` judges a reported pull request
 * against, so a proxy origin there would refuse genuine github.com pull requests and offer a
 * machine an address that is not a git remote (found in review).
 *
 * - a host of its own — `api.github.com`, and the data residency form `api.<tenant>.ghe.com`,
 *   where the site is the same name without the label;
 * - a path on the site — `https://HOST/api/v3`, which is Enterprise Server's documented base and
 *   the only spelling of it that works: a bare Enterprise origin would 404 every API call, so it
 *   cannot be a working configuration to preserve.
 *
 * Anything else — a proxy, a rewriting gateway, a typo, the end-to-end stub — keeps github.com,
 * which is what this answered before it was derived at all. A base that is not a url falls back
 * the same way rather than throwing: it is read on the render path of every project page.
 */
export function githubWebBase(raw = process.env.GITHUB_API_BASE_URL): string {
  if (!raw) return DEFAULT_WEB;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_WEB;
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/api/v3") return url.origin;
  if (path === "" && /^api\./i.test(url.hostname)) {
    url.hostname = url.hostname.replace(/^api\./i, "");
    return url.origin;
  }
  return DEFAULT_WEB;
}
