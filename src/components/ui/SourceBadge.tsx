import { isMachineSource, sourceLabel, sourceOf, sourceTitle } from "@/lib/activity-source-label";

export function SourceBadge({ source, detail, edited }: { source?: string; detail?: string; edited?: boolean }) {
  const shown = sourceOf(source);
  const title = edited ? `Last edited ${lowerFirst(sourceTitle(shown, detail))}` : sourceTitle(shown, detail);
  const tone = isMachineSource(shown)
    ? "border-primary/30 bg-primary/10 text-primary-on-tint"
    : "border-border bg-bg-input text-text-muted";
  return (
    <span
      data-testid="source-badge"
      data-source={shown}
      data-edited={edited ? "" : undefined}
      role="img"
      title={title}
      aria-label={title}
      className={`inline-flex flex-shrink-0 items-center whitespace-nowrap rounded border px-1 text-[10px] font-semibold uppercase leading-4 ${tone}`}
    >
      {edited ? `Edited · ${sourceLabel(shown)}` : sourceLabel(shown)}
    </span>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
