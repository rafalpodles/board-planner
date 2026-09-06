interface SavableGroup {
  label: string;
  save: () => Promise<void>;
}

export async function saveAllGroups(groups: SavableGroup[]): Promise<string[]> {
  const failed: string[] = [];

  for (const group of groups) {
    try {
      await group.save();
    } catch {
      failed.push(group.label);
    }
  }

  return failed;
}
