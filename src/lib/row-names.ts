export function distinctRowNames(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

  const used = new Set<string>();
  return names.map((name, index) => {
    let candidate = (counts.get(name) ?? 0) > 1 ? `${name} (${index + 1})` : name;
    while (used.has(candidate)) candidate = `${candidate} (${index + 1})`;
    used.add(candidate);
    return candidate;
  });
}
