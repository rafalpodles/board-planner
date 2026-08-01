// One definition of "what belongs in this person's thread", shared by the read API and
// the agent's history replay. If these two ever disagree, a user sees one conversation
// while the model is fed another.
export function pmThreadFilter(projectId: string, userId: string): Record<string, unknown> {
  return {
    project: projectId,
    $or: [
      { triggeredBy: userId },
      // Autonomous turns are board-level events, not anyone's private conversation
      { "trigger.type": { $ne: "chat" } },
    ],
  };
}
