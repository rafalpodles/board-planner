import { isMachineSource, sourceLabel, sourceOf, sourceTitle } from "@/lib/activity-source-label";

export function SourceBadge({ source, detail }: { source?: string; detail?: string }) {
  const shown = sourceOf(source);
  const title = sourceTitle(shown, detail);
  const tone = isMachineSource(shown)
    ? "border-primary/30 bg-primary/10 text-primary"
    : "border-border bg-bg-input text-text-muted";
  return (
    <span
      data-testid="source-badge"
      data-source={shown}
      role="img"
      title={title}
      aria-label={title}
      className={`inline-flex flex-shrink-0 items-center whitespace-nowrap rounded border px-1 text-[10px] font-semibold uppercase leading-4 ${tone}`}
    >
      {sourceLabel(shown)}
    </span>
  );
}
