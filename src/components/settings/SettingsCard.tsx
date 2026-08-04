"use client";

export function Chip({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusPill({ label, on }: { label: string; on: boolean }) {
  return (
    <Chip className={on ? "text-success border-success/45 bg-success/10" : "text-text-muted border-border bg-bg-input"}>
      {label}
    </Chip>
  );
}

interface SettingsCardProps {
  title: string;
  description?: string;
  instanceScoped?: boolean;
  status?: { label: string; on: boolean };
  danger?: boolean;
  children: React.ReactNode;
}

export function SettingsCard({
  title,
  description,
  instanceScoped,
  status,
  danger,
  children,
}: SettingsCardProps) {
  return (
    <section
      className={`mb-4 rounded-xl border bg-bg-card ${
        danger ? "border-danger/45" : "border-border"
      }`}
    >
      <header
        className={`flex flex-wrap items-center gap-2.5 border-b px-4 py-3 ${
          danger ? "border-danger/30" : "border-border"
        }`}
      >
        <h3 className={`text-[15px] font-semibold ${danger ? "text-danger" : ""}`}>{title}</h3>
        {instanceScoped && (
          <Chip className="text-text-muted border-border bg-bg-input">Instance admin</Chip>
        )}
        {status && <StatusPill label={status.label} on={status.on} />}
        <span className="flex-1" />
      </header>
      <div className="space-y-4 p-4">
        {description && <p className="max-w-[66ch] text-sm text-text-muted">{description}</p>}
        {children}
      </div>
    </section>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-text-muted">
      {children}
    </p>
  );
}

export function ListRow({
  children,
  align = "center",
}: {
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div
      className={`flex flex-wrap gap-2.5 rounded-lg border border-border bg-bg-input/30 px-3 py-2.5 ${
        align === "start" ? "items-start" : "items-center"
      }`}
    >
      {children}
    </div>
  );
}
