"use client";

interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, icon, actions }: PageHeaderProps) {
  return (
    <header className="@container relative z-20 mb-6 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {icon && (
            <span aria-hidden className="hidden shrink-0 text-2xl leading-none @md:inline">
              {icon}
            </span>
          )}
          <h1 className="truncate text-[15px] font-bold leading-tight @md:text-2xl">{title}</h1>
        </div>
        <div
          aria-hidden={!subtitle}
          className="h-[14px] truncate text-[11px] leading-tight text-text-muted"
        >
          {subtitle}
        </div>
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
