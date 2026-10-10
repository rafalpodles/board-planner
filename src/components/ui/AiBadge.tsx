export const AI_BADGE_TITLE = "Written by an AI model, not a person";

/** AI Act art. 50(1): whoever reads it is told it comes from an AI, not left to guess from a name. */
export function AiBadge({ title = AI_BADGE_TITLE }: { title?: string }) {
  return (
    <span
      data-testid="ai-badge"
      role="img"
      title={title}
      aria-label={title}
      className="inline-flex items-center rounded border border-primary/30 bg-primary/10 px-1 text-[10px] font-semibold uppercase leading-4 text-primary"
    >
      AI
    </span>
  );
}
