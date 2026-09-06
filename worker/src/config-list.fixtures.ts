/**
 * What `git config --list -z` actually prints, rendered from the readable `key=value` form the
 * test tables are written in.
 *
 * A fixture is not allowed to be the wire format's second opinion. These used to be plain
 * `key=value` lines, which cannot express what git really emits: a subsection name may contain
 * `=`, so `filter.a=b.smudge=<cmd>` is one key and one value to git and two different things to
 * anything splitting on the first `=`. Building the fixture from the pair rather than from the
 * line is what lets a test plant such a key at all — see repos.planted-config.integration.test.ts,
 * which plants one through the plain CLI against real git.
 */

type Entry = readonly [key: string, value: string];

function pairs(entries: string | readonly Entry[]): readonly Entry[] {
  if (typeof entries !== "string") return entries;
  return entries
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const eq = line.indexOf("=");
      return eq === -1 ? ([line, ""] as Entry) : ([line.slice(0, eq), line.slice(eq + 1)] as Entry);
    });
}

/** `git config --list -z` — one `key\nvalue\0` record per entry. */
export function configListZ(entries: string | readonly Entry[]): string {
  return pairs(entries)
    .map(([key, value]) => `${key}\n${value}\0`)
    .join("");
}

/** `git config --list -z --show-scope` — the scope is its own NUL-terminated field in front. */
export function scopedConfigListZ(entries: string | readonly Entry[], scope = "local"): string {
  return pairs(entries)
    .map(([key, value]) => `${scope}\0${key}\n${value}\0`)
    .join("");
}
