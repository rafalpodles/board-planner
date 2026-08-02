"use client";

interface PageHeaderProps {
  title: string;
  /** Second line, for a count or the project a page belongs to */
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  /** The page's primary action, right-aligned */
  actions?: React.ReactNode;
}

// The board's header, minus the sprint scope machinery that only it needs. Same
// 56px, same border, same type scale, so moving between pages changes nothing.
export function PageHeader({ title, subtitle, icon, actions }: PageHeaderProps) {
  return (
    // Geometry copied from BoardHeader, which is the reference idiom: it sits
    // inside main's padding rather than breaking out of it, so the two agree
    <header className="@container relative z-20 mb-6 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg px-6">
      {icon && (
        <span aria-hidden className="hidden shrink-0 text-[17px] leading-none @md:inline">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold leading-tight">{title}</h1>
        {subtitle && (
          <div className="truncate text-[11px] leading-tight text-text-muted">{subtitle}</div>
        )}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
