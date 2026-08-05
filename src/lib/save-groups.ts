interface SavableGroup {
  label: string;
  save: () => Promise<void>;
}

/**
 * Saves every group and returns the labels of those that threw.
 *
 * Sequential on purpose: several groups can PUT the same project document, and racing
 * them lets the last response win with a body assembled before the others landed.
 */
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
