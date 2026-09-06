"use client";

interface SettingRowProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}

export function SettingRow({ label, hint, htmlFor, children }: SettingRowProps) {
  const Label = htmlFor ? "label" : "div";

  return (
    <div className="flex flex-col gap-2 border-b border-border py-3.5 last:border-b-0 sm:flex-row sm:items-start sm:gap-6">
      <Label htmlFor={htmlFor} className="sm:w-[40%] sm:shrink-0 sm:pt-0.5">
        <strong className="block text-[13.5px] font-semibold">{label}</strong>
        {hint && <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>}
      </Label>
      <div className="min-w-0 flex-1 sm:max-w-[420px]">{children}</div>
    </div>
  );
}
