export const PRO_TRIAL_URL = "https://board-planner.com/trial/";

export function ProBadge() {
  return (
    <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
      Pro<span className="sr-only"> feature</span>
    </span>
  );
}

export function ProUpsell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4 text-sm" data-testid="pro-upsell">
      <p className="flex items-center gap-2 font-medium">
        {title}
        <ProBadge />
      </p>
      <div className="mt-1 text-text-muted">{children}</div>
      <p className="mt-2">
        <a
          href={PRO_TRIAL_URL}
          target="_blank"
          rel="noreferrer"
          className="focus-ring rounded text-primary underline"
        >
          Try Pro free for 30 days<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </p>
    </div>
  );
}
