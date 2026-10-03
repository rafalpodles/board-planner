export const PRO_TRIAL_URL = "https://board-planner.com/trial/";

export function ProUpsell({ feature, children }: { feature: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4 text-sm" data-testid="pro-upsell">
      <p className="font-medium">
        {feature} <span className="ml-1 rounded border border-primary px-1.5 py-0.5 text-xs text-primary">Pro</span>
      </p>
      <p className="mt-1 text-text-muted">{children}</p>
      <p className="mt-2">
        <a href={PRO_TRIAL_URL} target="_blank" rel="noreferrer" className="text-primary underline">
          Try Pro free for 30 days
        </a>
      </p>
    </div>
  );
}
