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

export function configListZ(entries: string | readonly Entry[]): string {
  return pairs(entries)
    .map(([key, value]) => `${key}\n${value}\0`)
    .join("");
}

export function scopedConfigListZ(entries: string | readonly Entry[], scope = "local"): string {
  return pairs(entries)
    .map(([key, value]) => `${scope}\0${key}\n${value}\0`)
    .join("");
}
