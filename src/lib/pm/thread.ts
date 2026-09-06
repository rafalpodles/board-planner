export function pmThreadFilter(projectId: string, userId: string): Record<string, unknown> {
  return {
    project: projectId,
    $or: [
      { triggeredBy: userId },
      { "trigger.type": { $ne: "chat" } },
    ],
  };
}
